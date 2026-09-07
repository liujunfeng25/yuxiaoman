import type { AppDatabase } from "./database.js";
import {
  applyWorkflowTransition,
  closeWorkflowTasks,
  enableWorkflowForEntity,
  type WorkflowTaskOpenInput,
} from "./workflow.js";

type Row = Record<string, unknown>;

export type WorkflowSyncOptions = {
  now?: Date;
  actorType?: "system" | "owner" | "station" | "operator" | "driver" | "repair_shop" | "platform" | "external_system";
  actorId?: string | null;
  /** Present only for the current driver assignment/re-assignment transaction. */
  verificationCode?: string;
  /** Close these nodes before opening the desired state, even if the state did not change. */
  forceReopenNodeCodes?: string[];
  /** Close and do not recreate these nodes (for example, driver.claim after code exchange). */
  suppressNodeCodes?: string[];
};

export type WorkflowSyncResult = {
  enabled: boolean;
  state: string | null;
  closed: number;
  opened: Awaited<ReturnType<typeof applyWorkflowTransition>>["opened"];
};

const ANNUAL_DOMAIN = "annual_inspection" as const;
const REPAIR_DOMAIN = "repair_quote" as const;
const TERMINAL_ANNUAL_STATES = new Set(["cancelled", "no_show"]);

function configuredWechatAppId(): string {
  return (process.env.WECHAT_MINIPROGRAM_APP_ID ?? process.env.WECHAT_APP_ID)?.trim() ?? "";
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function workflowIdentity(
  nodeCode: unknown,
  subjectType: unknown,
  subjectId: unknown,
  recipientUserId: unknown,
): string {
  const part = (value: unknown) => value == null ? "" : String(value);
  return JSON.stringify([part(nodeCode), part(subjectType), part(subjectId), part(recipientUserId)]);
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

function maskedPlate(value: unknown): string {
  const plate = String(value ?? "").trim();
  if (!plate) return "车辆";
  if (plate.length <= 3) return `${plate.slice(0, 1)}***`;
  return `${plate.slice(0, 2)}***${plate.slice(-1)}`;
}

function maskedBusinessCode(value: unknown): string {
  const code = String(value ?? "").trim();
  if (!code) return "***";
  return code.length <= 6 ? `***${code.slice(-2)}` : `***${code.slice(-6)}`;
}

function ownerOpenId(row: Row): string | null {
  return row.owner_wechat_openid == null ? null : String(row.owner_wechat_openid);
}

function appointmentAt(row: Row): Date {
  const date = String(row.appointment_date);
  const time = String(row.start_time).slice(0, 8);
  const parsed = new Date(`${date}T${time}+08:00`);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(String(row.updated_at));
}

function formatWechatAmount(fen: unknown): string {
  const value = Number(fen);
  if (!Number.isFinite(value) || value < 0) return "0.00";
  return (value / 100).toFixed(2);
}

function formatWechatEventTime(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function annualMetadata(row: Row, extra: Record<string, string | number> = {}): Record<string, string | number> {
  const reportConclusion = row.report_conclusion ?? row.result_conclusion;
  return {
    maskedPlate: maskedPlate(row.plate_number),
    maskedBusinessCode: maskedBusinessCode(row.booking_number),
    appointmentTime: `${String(row.appointment_date)} ${String(row.start_time).slice(0, 5)}`,
    stationName: String(row.station_name ?? "检测站"),
    reportConclusion: reportConclusion === "passed" ? "通过" : reportConclusion === "failed" ? "未通过" : "待发布",
    remainingTime: "策略规定时间",
    pendingCount: 1,
    overdueCount: 1,
    serviceAmount: formatWechatAmount(row.service_fee_fen),
    serviceItem: "机动车年检",
    warmTip: "请打开小程序查看详情",
    taskSummary: "年检服务待办",
    reviewStatus: "待处理",
    reviewResult: "需补充",
    eventTime: formatWechatEventTime(),
    ...extra,
  };
}

function ownerTask(row: Row, nodeCode: string, extra: Partial<WorkflowTaskOpenInput> = {}): WorkflowTaskOpenInput {
  return {
    nodeCode,
    recipientUserId: String(row.user_id),
    recipientPhone: row.contact_phone == null ? null : String(row.contact_phone),
    recipientWechatOpenId: ownerOpenId(row),
    subjectType: "owner",
    subjectId: String(row.user_id),
    assigneeRole: "owner",
    metadata: annualMetadata(row),
    ...extra,
  };
}

function stationTask(row: Row, nodeCode: string, extra: Partial<WorkflowTaskOpenInput> = {}): WorkflowTaskOpenInput {
  return {
    nodeCode,
    subjectType: "inspection_station",
    subjectId: String(row.station_id),
    assigneeRole: "station",
    metadata: annualMetadata(row),
    ...extra,
  };
}

function driverTask(row: Row, nodeCode: string, extra: Partial<WorkflowTaskOpenInput> = {}): WorkflowTaskOpenInput {
  return {
    nodeCode,
    recipientUserId: row.driver_user_id == null ? null : String(row.driver_user_id),
    recipientPhone: row.driver_phone == null ? null : String(row.driver_phone),
    recipientWechatOpenId: row.driver_wechat_openid == null ? null : String(row.driver_wechat_openid),
    subjectType: "driver_assignment",
    subjectId: row.assignment_id == null ? null : String(row.assignment_id),
    assigneeRole: "driver",
    metadata: annualMetadata(row),
    ...extra,
  };
}

async function annualRow(database: AppDatabase, bookingId: string): Promise<Row | undefined> {
  return database.prepare<Row>(`
    SELECT b.*, s.name AS station_name, v.plate_number,
      q.drive_minutes,
      a.id AS assignment_id, a.driver_phone, a.bound_user_id AS driver_user_id,
      a.status AS assignment_status, a.task_code_consumed_at,
      r.id AS report_id, r.status AS report_status, r.annual_conclusion AS report_conclusion,
      ir.conclusion AS result_conclusion,
      (SELECT i.provider_subject FROM user_identities i
        WHERE i.user_id = b.user_id AND i.provider = 'wechat' AND i.provider_app_id = ?
        ORDER BY i.updated_at DESC LIMIT 1) AS owner_wechat_openid,
      (SELECT i.provider_subject FROM user_identities i
        WHERE i.user_id = a.bound_user_id AND i.provider = 'wechat' AND i.provider_app_id = ?
        ORDER BY i.updated_at DESC LIMIT 1) AS driver_wechat_openid
    FROM bookings b
    INNER JOIN stations s ON s.id = b.station_id
    LEFT JOIN vehicles v ON v.id = b.vehicle_id
    LEFT JOIN quote_snapshots q ON q.id = b.quote_snapshot_id
    LEFT JOIN valet_driver_assignments a ON a.booking_id = b.id AND a.status <> 'cancelled'
    LEFT JOIN vehicle_checkup_reports r ON r.booking_id = b.id
    LEFT JOIN inspection_results ir ON ir.booking_id = b.id
    WHERE b.id = ?
  `).get(configuredWechatAppId(), configuredWechatAppId(), bookingId);
}

function annualState(row: Row): string {
  const fulfillment = String(row.fulfillment_status ?? "legacy");
  return fulfillment === "legacy" ? String(row.status) : fulfillment;
}

function annualDesiredTasks(row: Row, options: WorkflowSyncOptions): WorkflowTaskOpenInput[] {
  const now = options.now ?? new Date();
  const state = annualState(row);
  const serviceMode = String(row.service_mode);
  const appointment = appointmentAt(row);
  const desired: WorkflowTaskOpenInput[] = [];

  if (state === "pending_payment") {
    desired.push(ownerTask(row, "annual.pending_payment", {
      metadata: annualMetadata(row, { warmTip: "请进入小程序完成支付" }),
    }));
  } else if (state === "paid_pending_confirmation" || state === "pending_precheck") {
    desired.push(stationTask(row, "annual.precheck.pending", {
      metadata: annualMetadata(row, {
        taskSummary: "预约资料待预检",
        warmTip: "请尽快在工作台处理",
      }),
    }));
  } else if (state === "precheck_action_required" || state === "precheck_rejected") {
    desired.push(ownerTask(row, "annual.precheck.action_required", {
      firstReminderAt: now,
      metadata: annualMetadata(row, {
        warmTip: "请打开订单按指引处理",
        reviewStatus: "待处理",
        reviewResult: "需补充",
      }),
    }));
  } else if (state === "confirmed") {
    if (serviceMode === "valet") {
      desired.push({
        nodeCode: "annual.driver.assign",
        subjectType: "platform_duty",
        subjectId: null,
        assigneeRole: "platform",
        metadata: annualMetadata(row),
      });
    } else {
      desired.push(ownerTask(row, "annual.arrival.owner", {
        anchorAt: appointment,
        metadata: annualMetadata(row, { warmTip: "请按预约时间到站验车" }),
      }));
    }
  } else if (state === "awaiting_arrival") {
    desired.push(ownerTask(row, "annual.arrival.owner", {
      anchorAt: appointment,
      metadata: annualMetadata(row, { warmTip: "请按预约时间到站验车" }),
    }));
  } else if (state === "driver_arranged") {
    // A claimed one-time entry must stay closed. Ordinary same-state writes
    // (notes, fee adjustments, etc.) must never recreate a code-less claim.
    // Once the code is consumed, responsibility changes from "领取任务" to
    // "完成取车留证" without changing the canonical business state yet.
    if (row.task_code_consumed_at == null) {
      desired.push(driverTask(row, "annual.driver.claim", {
        sensitiveVariables: options.verificationCode ? { verificationCode: options.verificationCode } : undefined,
      }));
    } else {
      desired.push(driverTask(row, "annual.pickup.driver", {
        anchorAt: now,
      }));
    }
    desired.push(ownerTask(row, "annual.pickup.owner", {
      anchorAt: appointment,
    }));
  } else if (state === "picked_up") {
    desired.push(stationTask(row, "annual.station.arrival", {
      anchorAt: now,
    }));
  } else if (state === "checked_in") {
    const anchor = new Date(String(row.updated_at));
    desired.push(stationTask(row, "annual.inspection.start", { anchorAt: anchor }));
  } else if (state === "inspecting") {
    const anchor = new Date(String(row.updated_at));
    desired.push(stationTask(row, "annual.inspection.report", { anchorAt: anchor }));
  } else if (state === "result_received") {
    if (String(row.report_status) === "published") {
      desired.push(ownerTask(row, "annual.report.ready", {
        firstReminderAt: now,
        metadata: annualMetadata(row, { warmTip: "点击查看完整报告" }),
      }));
    }
    if (serviceMode === "valet") desired.push(driverTask(row, "annual.return.driver"));
  } else if (state === "returning") {
    if (String(row.report_status) === "published") {
      desired.push(ownerTask(row, "annual.report.ready", {
        firstReminderAt: now,
        metadata: annualMetadata(row, { warmTip: "点击查看完整报告" }),
      }));
    }
    const driveMinutes = Math.max(1, Number(row.drive_minutes ?? 30));
    desired.push(driverTask(row, "annual.return.delivery", {
      anchorAt: addMinutes(now, driveMinutes),
    }));
  } else if (state === "completed") {
    if (String(row.report_status) === "published") {
      desired.push(ownerTask(row, "annual.report.ready", {
        firstReminderAt: now,
        metadata: annualMetadata(row, { warmTip: "点击查看完整报告" }),
      }));
    }
    desired.push(ownerTask(row, "annual.service.completed", {
      firstReminderAt: now,
      metadata: annualMetadata(row, { warmTip: "可查看留证与报告" }),
    }));
  } else if (state === "on_hold") {
    desired.push({
      nodeCode: "workflow.exception",
      subjectType: "platform_duty",
      subjectId: null,
      assigneeRole: "platform",
      metadata: annualMetadata(row),
      firstReminderAt: now,
    });
  }
  const suppressed = new Set(options.suppressNodeCodes ?? []);
  return desired.filter((task) => !suppressed.has(String(task.nodeCode)));
}

async function syncDesired(
  database: AppDatabase,
  input: {
    domain: typeof ANNUAL_DOMAIN | typeof REPAIR_DOMAIN;
    entityType: "booking" | "repair_request";
    entityId: string;
    state: string;
    desired: WorkflowTaskOpenInput[];
  },
  options: WorkflowSyncOptions,
): Promise<WorkflowSyncResult> {
  const binding = await database.prepare<Row>(`
    SELECT id, subject_type, subject_id FROM workflow_entity_bindings
    WHERE domain = ? AND entity_type = ? AND entity_id = ?
  `).get(input.domain, input.entityType, input.entityId);
  if (!binding) return { enabled: false, state: input.state, closed: 0, opened: [] };

  const current = await database.prepare<Row>(`
    SELECT id, node_code, subject_type, subject_id, recipient_user_id,
      task_kind, status, closed_reason, metadata_json
    FROM workflow_tasks
    WHERE domain = ? AND entity_type = ? AND entity_id = ? AND (
      status = 'open' OR (
        task_kind = 'information' AND status = 'completed' AND closed_reason = 'notification_queued'
        AND EXISTS (
          SELECT 1 FROM notification_outbox o
          WHERE o.task_id = workflow_tasks.id AND o.status IN ('pending', 'retry', 'processing')
        )
      )
    )
  `).all(input.domain, input.entityType, input.entityId);
  const desiredIdentities = new Set(input.desired.map((task) => workflowIdentity(
    task.nodeCode,
    task.subjectType === undefined ? binding.subject_type : task.subjectType,
    task.subjectId === undefined ? binding.subject_id : task.subjectId,
    task.recipientUserId ?? null,
  )));
  const forceReopen = new Set([
    ...(options.forceReopenNodeCodes ?? []),
    ...(options.verificationCode ? ["annual.driver.claim"] : []),
  ]);
  const closeTaskIds = new Set<string>();
  // First decide which ordinary source tasks this business transition closes.
  // Exception retention below must see this prospective set so source and
  // exception can close atomically in a single synchronization pass.
  for (const row of current) {
    const code = String(row.node_code);
    if (code === "workflow.exception") continue;
    if (forceReopen.has(code)) {
      closeTaskIds.add(String(row.id));
      continue;
    }
    if (desiredIdentities.has(workflowIdentity(
      row.node_code,
      row.subject_type,
      row.subject_id,
      row.recipient_user_id,
    ))) continue;
    closeTaskIds.add(String(row.id));
  }
  for (const row of current) {
    const code = String(row.node_code);
    if (code !== "workflow.exception") continue;
    if (forceReopen.has(code)) {
      closeTaskIds.add(String(row.id));
      continue;
    }
    if (desiredIdentities.has(workflowIdentity(
      row.node_code,
      row.subject_type,
      row.subject_id,
      row.recipient_user_id,
    ))) continue;
    if (!TERMINAL_ANNUAL_STATES.has(input.state) && input.state !== "cancelled") {
      const metadata = jsonObject(row.metadata_json);
      const sourceTaskId = metadata.sourceTaskId;
      if (typeof sourceTaskId === "string" && sourceTaskId) {
        const source = await database.prepare<Row>(
          "SELECT status FROM workflow_tasks WHERE id = ? AND binding_id = ?",
        ).get(sourceTaskId, String(binding.id));
        if (source && String(source.status) === "open" && !closeTaskIds.has(sourceTaskId)) continue;
        // A delivery dead-letter is itself the unresolved condition. Its source
        // information task is already completed after durable queueing, so it
        // remains visible until a platform operator resolves this exception.
        if (typeof metadata.failureReason === "string" && metadata.failureReason) continue;
      }
      // Exceptions without an active source close only when the business has
      // moved away from the exceptional state that created them.
    }
    closeTaskIds.add(String(row.id));
  }
  const transition = await applyWorkflowTransition(database, {
    domain: input.domain,
    entityType: input.entityType,
    entityId: input.entityId,
    closeTaskIds: [...closeTaskIds],
    closeReason: TERMINAL_ANNUAL_STATES.has(input.state) || input.state === "cancelled"
      ? "business_terminal"
      : "business_state_synchronized",
    open: input.desired,
    forceCreateNodeCodes: [...forceReopen],
    actorType: options.actorType ?? "system",
    actorId: options.actorId ?? null,
  }, { now: options.now });
  return { enabled: true, state: input.state, closed: transition.closed, opened: transition.opened };
}

/** Enable only from the new-booking creation transaction. */
export async function enableAnnualWorkflowForBooking(
  database: AppDatabase,
  bookingId: string,
  options: WorkflowSyncOptions = {},
): Promise<WorkflowSyncResult> {
  const row = await annualRow(database, bookingId);
  if (!row) return { enabled: false, state: null, closed: 0, opened: [] };
  const binding = await enableWorkflowForEntity(database, {
    domain: ANNUAL_DOMAIN,
    entityType: "booking",
    entityId: bookingId,
    ownerUserId: String(row.user_id),
    subjectType: "inspection_station",
    subjectId: String(row.station_id),
    createdAt: options.now ?? new Date(String(row.created_at)),
  });
  if (!binding) return { enabled: false, state: annualState(row), closed: 0, opened: [] };
  return syncAnnualWorkflowForBooking(database, bookingId, options);
}

/** Synchronize only an already-enabled booking; historical rows remain untouched. */
export async function syncAnnualWorkflowForBooking(
  database: AppDatabase,
  bookingId: string,
  options: WorkflowSyncOptions = {},
): Promise<WorkflowSyncResult> {
  const row = await annualRow(database, bookingId);
  if (!row) return { enabled: false, state: null, closed: 0, opened: [] };
  const state = annualState(row);
  const desired = annualDesiredTasks(row, options)
    .filter((task) => !(options.suppressNodeCodes ?? []).includes(String(task.nodeCode)));
  return syncDesired(database, {
    domain: ANNUAL_DOMAIN,
    entityType: "booking",
    entityId: bookingId,
    state,
    desired,
  }, options);
}

async function repairRow(database: AppDatabase, requestId: string): Promise<Row | undefined> {
  return database.prepare<Row>(`
    SELECT r.*,
      COUNT(q.id)::INTEGER AS quote_count,
      COUNT(q.id) FILTER (WHERE q.status IN ('active', 'selected'))::INTEGER AS active_quote_count,
      COALESCE(o.shop_id, selected.shop_id) AS selected_shop_id,
      (SELECT b.contact_phone FROM bookings b WHERE b.id = r.source_booking_id) AS owner_phone,
      (SELECT i.provider_subject FROM user_identities i
        WHERE i.user_id = r.user_id AND i.provider = 'wechat' AND i.provider_app_id = ?
        ORDER BY i.updated_at DESC LIMIT 1) AS owner_wechat_openid
    FROM repair_requests r
    LEFT JOIN repair_quotes q ON q.request_id = r.id
    LEFT JOIN repair_quotes selected ON selected.id = r.selected_quote_id
    LEFT JOIN repair_orders o ON o.request_id = r.id
    WHERE r.id = ?
    GROUP BY r.id, o.shop_id, selected.shop_id
  `).get(configuredWechatAppId(), requestId);
}

function repairMetadata(row: Row): Record<string, string | number> {
  const vehicle = jsonObject(row.vehicle_snapshot_json);
  return {
    maskedPlate: maskedPlate(vehicle.plateNumber ?? vehicle.plate_number),
    maskedBusinessCode: maskedBusinessCode(row.request_no),
    remainingTime: "策略规定时间",
    pendingCount: 1,
    overdueCount: 1,
  };
}

async function repairDesiredTasks(database: AppDatabase, row: Row, options: WorkflowSyncOptions): Promise<WorkflowTaskOpenInput[]> {
  const now = options.now ?? new Date();
  const status = String(row.status);
  const metadata = repairMetadata(row);
  if (status === "cancelled") return [];
  if (status === "paid") {
    const shopId = row.selected_shop_id == null ? null : String(row.selected_shop_id);
    return shopId ? [{
      nodeCode: "repair.order.selected",
      subjectType: "repair_shop",
      subjectId: shopId,
      assigneeRole: "repair_shop",
      metadata,
      firstReminderAt: now,
    }] : [{
      nodeCode: "workflow.exception",
      subjectType: "platform_duty",
      subjectId: null,
      assigneeRole: "platform",
      metadata,
      firstReminderAt: now,
    }];
  }
  const activeQuoteCount = Number(row.active_quote_count ?? 0);
  if (activeQuoteCount > 0) {
    return [{
      nodeCode: "repair.quote.owner_action",
      recipientUserId: String(row.user_id),
      recipientPhone: row.owner_phone == null ? null : String(row.owner_phone),
      recipientWechatOpenId: row.owner_wechat_openid == null ? null : String(row.owner_wechat_openid),
      subjectType: "owner",
      subjectId: String(row.user_id),
      assigneeRole: "owner",
      metadata,
      firstReminderAt: now,
    }];
  }
  const shops = await database.prepare<Row>(`
    SELECT id FROM repair_shops WHERE is_active = 1 ORDER BY sort_order, id
  `).all();
  return shops.flatMap((shop): WorkflowTaskOpenInput[] => ([{
      nodeCode: "repair.request.opportunity",
      subjectType: "repair_shop",
      subjectId: String(shop.id),
      assigneeRole: "repair_shop",
      metadata,
      firstReminderAt: now,
    }, {
      nodeCode: "repair.quote.first",
      subjectType: "repair_shop",
      subjectId: String(shop.id),
      assigneeRole: "repair_shop",
      metadata,
    }]));
}

/** Enable only from either new repair-request creation transaction. */
export async function enableRepairWorkflowForRequest(
  database: AppDatabase,
  requestId: string,
  options: WorkflowSyncOptions = {},
): Promise<WorkflowSyncResult> {
  const row = await repairRow(database, requestId);
  if (!row) return { enabled: false, state: null, closed: 0, opened: [] };
  const binding = await enableWorkflowForEntity(database, {
    domain: REPAIR_DOMAIN,
    entityType: "repair_request",
    entityId: requestId,
    ownerUserId: String(row.user_id),
    createdAt: options.now ?? new Date(String(row.created_at)),
  });
  if (!binding) return { enabled: false, state: String(row.status), closed: 0, opened: [] };
  return syncRepairWorkflowForRequest(database, requestId, options);
}

/** Synchronize only an already-enabled repair request; reading historical data never opts it in. */
export async function syncRepairWorkflowForRequest(
  database: AppDatabase,
  requestId: string,
  options: WorkflowSyncOptions = {},
): Promise<WorkflowSyncResult> {
  const row = await repairRow(database, requestId);
  if (!row) return { enabled: false, state: null, closed: 0, opened: [] };
  const desired = (await repairDesiredTasks(database, row, options))
    .filter((task) => !(options.suppressNodeCodes ?? []).includes(String(task.nodeCode)));
  return syncDesired(database, {
    domain: REPAIR_DOMAIN,
    entityType: "repair_request",
    entityId: requestId,
    state: String(row.status),
    desired,
  }, options);
}

/** Close claim and atomically open the driver's pickup-evidence task after code exchange. */
export async function acknowledgeAnnualDriverClaim(
  database: AppDatabase,
  bookingId: string,
  options: Omit<WorkflowSyncOptions, "suppressNodeCodes"> = {},
): Promise<WorkflowSyncResult> {
  return syncAnnualWorkflowForBooking(database, bookingId, {
    ...options,
    suppressNodeCodes: ["annual.driver.claim"],
  });
}

/** Convenience for terminal paths that delete/cancel before the row can be re-read. */
export async function closeAnnualWorkflow(
  database: AppDatabase,
  bookingId: string,
  options: WorkflowSyncOptions & { reason?: string } = {},
): Promise<number> {
  return closeWorkflowTasks(database, {
    domain: ANNUAL_DOMAIN,
    entityType: "booking",
    entityId: bookingId,
    reason: options.reason ?? "business_terminal",
    actorType: options.actorType ?? "system",
    actorId: options.actorId ?? null,
  }, { now: options.now });
}

export async function closeRepairWorkflow(
  database: AppDatabase,
  requestId: string,
  options: WorkflowSyncOptions & { reason?: string } = {},
): Promise<number> {
  return closeWorkflowTasks(database, {
    domain: REPAIR_DOMAIN,
    entityType: "repair_request",
    entityId: requestId,
    reason: options.reason ?? "business_terminal",
    actorType: options.actorType ?? "system",
    actorId: options.actorId ?? null,
  }, { now: options.now });
}
