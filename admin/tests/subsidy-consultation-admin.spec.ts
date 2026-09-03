import { expect, test, type Page, type Route } from "@playwright/test";

type Trace = {
  savedDrafts: Array<Record<string, unknown>>;
  publishes: number;
  materialReads: string[];
  handleBody?: Record<string, unknown>;
};

const administrativeFees = {
  plateFeeFen: 12_000,
  mailingFeeFen: 2_000,
  productionFeeFen: 1_000,
};

const tiers = [
  { id: "tier-20", label: "20万元以内", minValueFen: 0, maxValueFen: 20_000_000, feeFen: 15_000, totalTransferCostFen: 30_000, sortOrder: 0 },
  { id: "tier-30", label: "20万至30万元", minValueFen: 20_000_000, maxValueFen: 30_000_000, feeFen: 25_000, totalTransferCostFen: 40_000, sortOrder: 1 },
  { id: "tier-40", label: "30万至40万元", minValueFen: 30_000_000, maxValueFen: 40_000_000, feeFen: 35_000, totalTransferCostFen: 50_000, sortOrder: 2 },
  { id: "tier-50", label: "40万至50万元", minValueFen: 40_000_000, maxValueFen: 50_000_000, feeFen: 45_000, totalTransferCostFen: 60_000, sortOrder: 3 },
];

const materialKinds = [
  "id_card_front",
  "id_card_back",
  "driving_license_front",
  "driving_license_back",
  "vehicle_front_left",
  "vehicle_front_right",
  "vehicle_rear_left",
  "vehicle_rear_right",
  "dashboard_started",
];

async function installSubsidyMock(page: Page): Promise<Trace> {
  const trace: Trace = { savedDrafts: [], publishes: 0, materialReads: [] };
  let draft = { id: "plan-draft", version: null, state: "draft", active: true, administrativeFees: structuredClone(administrativeFees), administrativeFeeFen: 15_000, tiers: structuredClone(tiers), updatedAt: "2026-08-22T08:00:00.000Z", publishedAt: null };
  let published = { id: "plan-v1", version: 1, state: "published", active: true, administrativeFees: structuredClone(administrativeFees), administrativeFeeFen: 15_000, tiers: structuredClone(tiers), updatedAt: "2026-08-22T08:00:00.000Z", publishedAt: "2026-08-22T08:00:00.000Z" };
  let detail = {
    id: "subsidy-consultation-1",
    consultationCode: "YXM-ZX-20260822-DEMO0001",
    status: "new",
    contactNameMasked: "王**",
    maskedPhone: "138****8000",
    vehiclePlateMasked: "津A·***01",
    vehicleModelName: "演示新能源轿车",
    declaredValueFen: 20_000_000,
    consultationFeeFen: 15_000,
    administrativeFees: structuredClone(administrativeFees),
    administrativeFeeFen: 15_000,
    totalTransferCostFen: 30_000,
    planVersion: 1,
    submittedAt: "2026-08-22T08:20:00.000Z",
    handledAt: null as string | null,
    withdrawnAt: null,
    expiredAt: null,
    handleResult: null as string | null,
    matchedTier: tiers[0],
    contact: { name: "演示车主", phone: "13800138000" },
    internalNote: null as string | null,
    materials: materialKinds.map((kind, index) => ({
      id: `material-${index + 1}`,
      kind,
      status: "bound",
      mimeType: "image/png",
      sizeBytes: 1024 + index,
      available: true,
    })),
    events: [{ action: "consultation_created", actorType: "owner", createdAt: "2026-08-22T08:20:00.000Z" }],
  };

  const fulfill = (route: Route, data: unknown, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ data }),
  });

  await page.route("**/api/admin/subsidy**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/admin/subsidy-consultation/fee-plan" && method === "GET") {
      return fulfill(route, { draft, published, active: published });
    }
    if (path === "/api/admin/subsidy-consultation/fee-plan/draft" && method === "PUT") {
      const body = request.postDataJSON() as { active: boolean; administrativeFees: typeof administrativeFees; tiers: typeof tiers };
      trace.savedDrafts.push(body as unknown as Record<string, unknown>);
      const administrativeFeeFen = Object.values(body.administrativeFees).reduce((sum, value) => sum + value, 0);
      draft = {
        ...draft,
        active: body.active,
        administrativeFees: body.administrativeFees,
        administrativeFeeFen,
        tiers: body.tiers.map((tier) => ({ ...tier, totalTransferCostFen: tier.feeFen + administrativeFeeFen })),
        updatedAt: "2026-08-22T09:00:00.000Z",
      };
      return fulfill(route, { draft, published, active: published });
    }
    if (path === "/api/admin/subsidy-consultation/fee-plan/publish" && method === "POST") {
      trace.publishes += 1;
      published = { ...draft, id: "plan-v2", version: 2, state: "published", publishedAt: "2026-08-22T09:01:00.000Z" };
      return fulfill(route, { draft, published, active: published });
    }
    if (path === "/api/admin/subsidy-consultations" && method === "GET") {
      const requestedStatus = url.searchParams.get("status");
      const item = {
        id: detail.id,
        consultationCode: detail.consultationCode,
        status: detail.status,
        contactNameMasked: detail.contactNameMasked,
        maskedPhone: detail.maskedPhone,
        vehiclePlateMasked: detail.vehiclePlateMasked,
        vehicleModelName: detail.vehicleModelName,
        declaredValueFen: detail.declaredValueFen,
        consultationFeeFen: detail.consultationFeeFen,
        administrativeFees: detail.administrativeFees,
        administrativeFeeFen: detail.administrativeFeeFen,
        totalTransferCostFen: detail.totalTransferCostFen,
        planVersion: detail.planVersion,
        submittedAt: detail.submittedAt,
        handledAt: detail.handledAt,
        handleResult: detail.handleResult,
      };
      const items = !requestedStatus || requestedStatus === detail.status ? [item] : [];
      return fulfill(route, { items, total: items.length, page: 1, pageSize: 20 });
    }
    const materialMatch = path.match(/^\/api\/admin\/subsidy-consultations\/([^/]+)\/materials\/([^/]+)$/u);
    if (materialMatch && method === "GET") {
      trace.materialReads.push(materialMatch[2]);
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      return route.fulfill({ status: 200, contentType: "image/png", headers: { "Cache-Control": "private, no-store" }, body: png });
    }
    if (path === `/api/admin/subsidy-consultations/${detail.id}/handle` && method === "POST") {
      trace.handleBody = request.postDataJSON() as Record<string, unknown>;
      detail = {
        ...detail,
        status: "handled",
        handledAt: "2026-08-22T09:10:00.000Z",
        handleResult: String(trace.handleBody.result),
        internalNote: String(trace.handleBody.note || ""),
      };
      return fulfill(route, {
        id: detail.id,
        consultationCode: detail.consultationCode,
        status: detail.status,
        contactNameMasked: detail.contactNameMasked,
        maskedPhone: detail.maskedPhone,
        vehiclePlateMasked: detail.vehiclePlateMasked,
        vehicleModelName: detail.vehicleModelName,
        declaredValueFen: detail.declaredValueFen,
        consultationFeeFen: detail.consultationFeeFen,
        administrativeFees: detail.administrativeFees,
        administrativeFeeFen: detail.administrativeFeeFen,
        totalTransferCostFen: detail.totalTransferCostFen,
        planVersion: detail.planVersion,
        submittedAt: detail.submittedAt,
        handledAt: detail.handledAt,
        handleResult: detail.handleResult,
      });
    }
    if (path === `/api/admin/subsidy-consultations/${detail.id}` && method === "GET") return fulfill(route, detail);
    return fulfill(route, { error: { message: `Unhandled subsidy mock ${method} ${path}` } }, 404);
  });
  return trace;
}

test("补贴咨询可维护行政性收费与阶梯费用并发布带合计的新版本", async ({ page }) => {
  const trace = await installSubsidyMock(page);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await page.getByRole("button", { name: "补贴咨询" }).click();
  await expect(page.getByRole("heading", { name: "补贴咨询与价格维护" })).toBeVisible();
  await page.getByRole("tab", { name: "咨询价格维护" }).click();

  await expect(page.getByText("当前生效版本")).toContainText("1");
  await expect(page.getByLabel("牌照费")).toHaveValue("120");
  await expect(page.getByLabel("邮寄费")).toHaveValue("20");
  await expect(page.getByLabel("制作工本费")).toHaveValue("10");
  const previewCards = page.locator(".subsidy-client-preview article");
  await expect(previewCards).toHaveCount(4);
  await expect(previewCards.nth(0)).toContainText("¥300.00");
  await expect(previewCards.nth(1)).toContainText("¥400.00");
  await expect(previewCards.nth(2)).toContainText("¥500.00");
  await expect(previewCards.nth(3)).toContainText("¥600.00");
  await page.getByLabel("牌照费").fill("130");
  await expect(page.getByText("行政性收费小计").locator("..")).toContainText("¥160.00");
  await expect(previewCards.nth(0)).toContainText("¥310.00");
  await expect(page.getByLabel("档位 1 咨询价")).toHaveValue("150");
  await page.getByLabel("档位 1 咨询价").fill("160");
  await expect(previewCards.nth(0)).toContainText("¥320.00");
  await page.getByRole("button", { name: "新增估值档位" }).click();
  await expect(page.getByLabel("档位 5 名称")).toBeVisible();
  await expect(page.getByLabel("档位 5 上限")).toHaveValue("50");
  await page.getByRole("button", { name: "上移档位 2" }).click();

  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText("草稿已保存，尚未影响小程序报价")).toBeVisible();
  expect(trace.savedDrafts).toHaveLength(1);
  const savedTiers = trace.savedDrafts[0].tiers as Array<Record<string, unknown>>;
  expect(savedTiers).toHaveLength(5);
  expect(savedTiers.some((tier) => tier.feeFen === 16_000)).toBe(true);
  expect(savedTiers.map((tier) => tier.sortOrder)).toEqual([0, 1, 2, 3, 4]);
  expect(trace.savedDrafts[0].administrativeFees).toEqual({
    plateFeeFen: 13_000,
    mailingFeeFen: 2_000,
    productionFeeFen: 1_000,
  });

  await page.getByRole("button", { name: "发布生效" }).click();
  await expect(page.getByText(/价格已发布 · 版本 2/u)).toBeVisible();
  expect(trace.savedDrafts).toHaveLength(2);
  expect(trace.publishes).toBe(1);
  expect(trace.savedDrafts[1].administrativeFees).toEqual(trace.savedDrafts[0].administrativeFees);
  await expect(page.getByText("以上均为参考，以办理机构实际收取及所选服务为准；本模块不收款、不代办理、不承诺结果。")).toBeVisible();

  await page.getByRole("tab", { name: "咨询申请" }).click();
  await page.getByRole("row", { name: /YXM-ZX-20260822-DEMO0001/u }).click();
  const historicalSnapshot = page.getByLabel("补贴咨询详情").locator(".detail-section").filter({ hasText: "咨询人与价格快照" });
  await expect(historicalSnapshot.locator("dl > div").filter({ hasText: "牌照费" })).toContainText("¥120.00");
  await expect(historicalSnapshot.locator("dl > div").filter({ hasText: "过户费用合计（参考）" })).toContainText("¥300.00");
});

test("补贴咨询列表默认脱敏，详情逐项按需读取并只允许新提交转已处理", async ({ page }) => {
  const trace = await installSubsidyMock(page);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await page.getByRole("button", { name: "补贴咨询" }).click();

  await expect(page.getByText("YXM-ZX-20260822-DEMO0001")).toBeVisible();
  await expect(page.getByText("138****8000")).toBeVisible();
  await expect(page.getByText("13800138000")).not.toBeVisible();
  const listRow = page.getByRole("row", { name: /YXM-ZX-20260822-DEMO0001/u });
  await expect(listRow).toContainText("¥300.00");
  await expect(listRow).toContainText("咨询 ¥150.00 + 行政性收费 ¥150.00");
  await listRow.click();

  const drawer = page.getByLabel("补贴咨询详情");
  await expect(drawer.getByText("敏感资料按需查看并留痕")).toBeVisible();
  await expect(drawer.getByText("13800138000")).toBeVisible();
  const feeSnapshot = drawer.locator(".detail-section").filter({ hasText: "咨询人与价格快照" });
  await expect(feeSnapshot.locator("dl > div").filter({ hasText: "咨询服务费" })).toContainText("¥150.00");
  await expect(feeSnapshot.locator("dl > div").filter({ hasText: "牌照费" })).toContainText("¥120.00");
  await expect(feeSnapshot.locator("dl > div").filter({ hasText: "邮寄费" })).toContainText("¥20.00");
  await expect(feeSnapshot.locator("dl > div").filter({ hasText: "制作工本费" })).toContainText("¥10.00");
  await expect(feeSnapshot.locator("dl > div").filter({ hasText: "行政性收费小计" })).toContainText("¥150.00");
  await expect(feeSnapshot.locator("dl > div").filter({ hasText: "过户费用合计（参考）" })).toContainText("¥300.00");
  await expect(feeSnapshot.getByText("费用快照仅供参考，以办理机构实际收取及所选服务为准；本模块不收款、不代办理。")).toBeVisible();
  await expect(drawer.locator(".subsidy-material-grid article")).toHaveCount(9);
  await expect(drawer.getByRole("button", { name: /下载/u })).toHaveCount(0);

  await drawer.getByRole("button", { name: "查看资料" }).first().click();
  await expect(drawer.getByRole("img", { name: "身份证正面" })).toBeVisible();
  expect(trace.materialReads).toEqual(["material-1"]);

  await drawer.getByLabel("咨询处理结果").selectOption("consultation_completed");
  await drawer.getByLabel("咨询内部备注").fill("已完成合规政策咨询");
  await drawer.getByRole("button", { name: "标记为已处理" }).click();
  await expect.poll(() => trace.handleBody?.result).toBe("consultation_completed");
  await expect(drawer.getByText("已完成咨询")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "标记为已处理" })).toHaveCount(0);
});

test("补贴咨询列表按服务端总数分页并传递 page 与 pageSize", async ({ page }) => {
  await installSubsidyMock(page);
  const requestedPages: Array<{ page: string | null; pageSize: string | null }> = [];
  const allItems = Array.from({ length: 25 }, (_, index) => ({
    id: `subsidy-page-${index + 1}`,
    consultationCode: `YXM-ZX-PAGE-${String(index + 1).padStart(2, "0")}`,
    status: index % 2 === 0 ? "new" : "handled",
    contactNameMasked: `车主${index + 1}**`,
    maskedPhone: `138****${String(8000 + index).slice(-4)}`,
    vehiclePlateMasked: `津A·${String(index + 1).padStart(3, "0")}`,
    vehicleModelName: `分页测试车型 ${index + 1}`,
    declaredValueFen: 20_000_000,
    consultationFeeFen: 15_000,
    planVersion: 1,
    submittedAt: "2026-08-22T08:20:00.000Z",
  }));

  await page.route("**/api/admin/subsidy-consultations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/admin/subsidy-consultations" || request.method() !== "GET") return route.fallback();
    const requestedPage = Number(url.searchParams.get("page") || 1);
    const requestedPageSize = Number(url.searchParams.get("pageSize") || 20);
    requestedPages.push({ page: url.searchParams.get("page"), pageSize: url.searchParams.get("pageSize") });
    const start = (requestedPage - 1) * requestedPageSize;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {
        items: allItems.slice(start, start + requestedPageSize),
        total: allItems.length,
        page: requestedPage,
        pageSize: requestedPageSize,
      } }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await page.getByRole("button", { name: "补贴咨询" }).click();

  const pagination = page.getByLabel("补贴咨询分页");
  await expect(pagination).toContainText("共 25 条 · 第 1/2 页");
  await expect(page.locator(".subsidy-consultation-card tbody tr")).toHaveCount(20);
  expect(requestedPages[0]).toEqual({ page: "1", pageSize: "20" });

  await pagination.getByRole("button", { name: "下一页咨询" }).click();
  await expect(pagination).toContainText("共 25 条 · 第 2/2 页");
  await expect(page.locator(".subsidy-consultation-card tbody tr")).toHaveCount(5);
  await expect(page.getByText("YXM-ZX-PAGE-21")).toBeVisible();
  expect(requestedPages.at(-1)).toEqual({ page: "2", pageSize: "20" });
  await expect(pagination.getByRole("button", { name: "下一页咨询" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "上一页咨询" })).toBeEnabled();
});

test("A 详情迟到且 B 请求失败时不会覆盖或污染当前抽屉", async ({ page }) => {
  await installSubsidyMock(page);
  let releaseA: (() => void) | undefined;
  let markARequested: (() => void) | undefined;
  const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
  const aRequested = new Promise<void>((resolve) => { markARequested = resolve; });
  const listItems = [
    {
      id: "subsidy-race-a",
      consultationCode: "YXM-ZX-RACE-A",
      status: "new",
      contactNameMasked: "甲**",
      maskedPhone: "138****0001",
      vehiclePlateMasked: "津A·A01",
      vehicleModelName: "竞态测试车型 A",
      declaredValueFen: 20_000_000,
      consultationFeeFen: 15_000,
      planVersion: 1,
      submittedAt: "2026-08-22T08:20:00.000Z",
    },
    {
      id: "subsidy-race-b",
      consultationCode: "YXM-ZX-RACE-B",
      status: "new",
      contactNameMasked: "乙**",
      maskedPhone: "138****0002",
      vehiclePlateMasked: "津A·B02",
      vehicleModelName: "竞态测试车型 B",
      declaredValueFen: 30_000_000,
      consultationFeeFen: 25_000,
      planVersion: 1,
      submittedAt: "2026-08-22T08:21:00.000Z",
    },
  ];

  await page.route("**/api/admin/subsidy-consultations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") return route.fallback();
    if (url.pathname === "/api/admin/subsidy-consultations") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { items: listItems, total: 2, page: 1, pageSize: 20 } }),
      });
    }
    if (url.pathname === "/api/admin/subsidy-consultations/subsidy-race-a") {
      markARequested?.();
      await aGate;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: {
          ...listItems[0],
          contact: { name: "甲详情", phone: "13900000001" },
          materials: [],
        } }),
      }).catch(() => undefined);
    }
    if (url.pathname === "/api/admin/subsidy-consultations/subsidy-race-b") {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "B 详情暂时不可用" } }),
      });
    }
    return route.fallback();
  });

  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await page.getByRole("button", { name: "补贴咨询" }).click();
  await expect(page.getByText("YXM-ZX-RACE-A")).toBeVisible();

  await page.getByRole("row", { name: /YXM-ZX-RACE-A/u }).click();
  await aRequested;
  await page.getByRole("button", { name: "关闭咨询详情" }).click();
  await page.getByRole("row", { name: /YXM-ZX-RACE-B/u }).click();

  const drawer = page.getByLabel("补贴咨询详情");
  await expect(drawer.getByText("敏感详情读取失败")).toBeVisible();
  await expect(drawer.getByText("B 详情暂时不可用")).toBeVisible();
  releaseA?.();
  await page.waitForTimeout(100);
  await expect(drawer.getByText("B 详情暂时不可用")).toBeVisible();
  await expect(drawer.getByText("13900000001")).toHaveCount(0);
});
