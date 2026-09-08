import type { Booking } from "../types";

export type OperatorTaskCard = {
  stepIndex: number;
  stepTotal: 5;
  title: string;
  instruction: string;
  nextLabel: string;
  primaryLabel: string;
  primaryHint: string;
};

const TOTAL = 5 as const;

export function buildOperatorTaskCard(booking: Booking): OperatorTaskCard {
  const status = booking.status;
  const mode = booking.serviceMode;

  if (status === "on_hold") {
    return {
      stepIndex: 2,
      stepTotal: TOTAL,
      title: "异常挂起",
      instruction: "车辆信息不一致，现场复核完成后再恢复。",
      nextLabel: "恢复后回到挂起前步骤",
      primaryLabel: "异常已处理，恢复核验",
      primaryHint: "恢复后请继续完成当前步骤主操作",
    };
  }

  if (status === "confirmed") {
    if (mode === "valet") {
      return {
        stepIndex: 1,
        stepTotal: TOTAL,
        title: "预约确认",
        instruction: "支付已确认，等待后台安排司机。",
        nextLabel: "完成后进入：到站核验",
        primaryLabel: "",
        primaryHint: "等待司机任务下发后再继续",
      };
    }
    return {
      stepIndex: 1,
      stepTotal: TOTAL,
      title: "预约确认",
      instruction: "确认接单，等待车辆按预约到站。",
      nextLabel: "完成后进入：到站核验",
      primaryLabel: "接单并等待到站",
      primaryHint: "接单后订单进入待到站，不会自动完成核验",
    };
  }

  if (status === "awaiting_arrival" || status === "picked_up" || status === "driver_arranged") {
    const canCheckIn =
      status === "awaiting_arrival" ||
      (status === "picked_up" && booking.evidencePolicyVersion !== "valet-handoff-v1");
    return {
      stepIndex: 2,
      stepTotal: TOTAL,
      title: "到站核验",
      instruction: "核对实车车牌与预约资料，确认车辆已到站。",
      nextLabel: "完成后进入：交接检测",
      primaryLabel: canCheckIn ? "确认到车 · 核验通过" : "",
      primaryHint: canCheckIn
        ? "不等于开始检测，仅标记到站完成"
        : "请完成接车留证或等待车辆到站后再核验",
    };
  }

  if (status === "checked_in") {
    return {
      stepIndex: 3,
      stepTotal: TOTAL,
      title: "交接检测",
      instruction: "确认车辆可进入检测线，交给检测流程处理。",
      nextLabel: "完成后进入：结果回传",
      primaryLabel: "确认交接 · 开始检测",
      primaryHint: "之后请在设备侧检测，再回小程序填报告",
    };
  }

  if (status === "inspecting") {
    return {
      stepIndex: 4,
      stepTotal: TOTAL,
      title: "结果回传",
      instruction: "补齐现场照片与年检结论，生成体检报告并同步车主。",
      nextLabel: "完成后进入：服务完成",
      primaryLabel: "填写体检报告并回传",
      primaryHint: "未完成报告前，订单会停在「检测中」",
    };
  }

  if (status === "result_received") {
    const legacy = booking.fulfillmentStatus === "legacy";
    return {
      stepIndex: 4,
      stepTotal: TOTAL,
      title: "结果回传",
      instruction: legacy ? "历史遗留单需手工收尾。" : "检测结果已回传，等待服务收尾。",
      nextLabel: "完成后进入：服务完成",
      primaryLabel: legacy ? "完成历史遗留服务" : "",
      primaryHint: legacy ? "确认后订单将标记为已完成" : "请确认结果区信息",
    };
  }

  if (status === "returning") {
    return {
      stepIndex: 5,
      stepTotal: TOTAL,
      title: "服务完成",
      instruction: "车辆送回中，最终送达与留证由本单司机完成。",
      nextLabel: "本单收尾中",
      primaryLabel: "",
      primaryHint: "",
    };
  }

  if (status === "completed") {
    return {
      stepIndex: 5,
      stepTotal: TOTAL,
      title: "服务完成",
      instruction: "结果已同步给车主。",
      nextLabel: "本单已结束",
      primaryLabel: "",
      primaryHint: "",
    };
  }

  return {
    stepIndex: 1,
    stepTotal: TOTAL,
    title: "等待处理",
    instruction: "当前无站内可执行主操作，请查看时间线或刷新后再试。",
    nextLabel: "完成后进入：下一可操作步骤",
    primaryLabel: "",
    primaryHint: "",
  };
}
