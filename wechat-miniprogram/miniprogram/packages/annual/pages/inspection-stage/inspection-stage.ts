import { api } from "../../../../services/api";
import type { Booking, Vehicle } from "../../../../types";
import { statusLabel } from "../../../../utils/format";

type StepId = "booking" | "arrival" | "materials" | "result";
type StageAction = "book" | "eligibility" | "order" | "report" | "navigate" | "orders";
type StageFact = { label: string; value: string };
type StageTip = { title: string; copy: string };
type StageView = {
  stepNumber: string;
  eyebrow: string;
  title: string;
  description: string;
  stateLabel: string;
  tone: "neutral" | "active" | "success" | "attention";
  iconPath: string;
  facts: StageFact[];
  tips: StageTip[];
  primaryLabel: string;
  primaryAction: StageAction;
};

type Data = {
  step: StepId;
  loading: boolean;
  vehicle: Vehicle | null;
  order: Booking | null;
  stage: StageView;
  stationPhone: string;
  showArrivalContact: boolean;
  resultPassed: boolean;
  usesWechatPay: boolean;
};

const STOPPED = new Set(["cancelled", "no_show"]);
const IN_PROGRESS_STOPPED = new Set(["completed", "cancelled", "no_show"]);

function bookingPriority(item: Booking): number {
  if (!IN_PROGRESS_STOPPED.has(item.status)) return 3;
  if (item.inspectionResult || item.status === "completed" || item.status === "result_received") return 2;
  return 1;
}

function latestBooking(items: Booking[]): Booking | null {
  return [...items].sort((left, right) => {
    const priority = bookingPriority(right) - bookingPriority(left);
    return priority || right.createdAt.localeCompare(left.createdAt);
  })[0] || null;
}

function vehicleLabel(vehicle: Vehicle | null, order: Booking | null): string {
  return order?.vehicle?.plateNumber || vehicle?.plateNumber || "尚未添加车辆";
}

function orderTime(order: Booking): string {
  return `${order.appointmentDate} ${order.startTime}–${order.endTime}`;
}

function inspectionResultLabel(order: Booking | null): string {
  if (!order?.inspectionResult) return "";
  if (order.inspectionResult.conclusion === "passed") return "通过";
  if (order.inspectionResult.conclusion === "failed") return "未通过";
  return order.inspectionResult.conclusionStatus === "legacy_requires_reentry" ? "历史结果待重新录入" : "结果未确认";
}

function buildStage(step: StepId, vehicle: Vehicle | null, order: Booking | null, usesWechatPay = false): StageView {
  const inProgress = order && !IN_PROGRESS_STOPPED.has(order.status) ? order : null;
  const usableOrder = order && !STOPPED.has(order.status) ? order : null;
  const plate = vehicleLabel(vehicle, order);

  if (step === "booking") {
    if (inProgress) {
      const awaitingPayment = inProgress.status === "pending_payment" || inProgress.paymentStatus === "unpaid";
      return {
        stepNumber: "01", eyebrow: "在线预约",
        title: awaitingPayment
          ? (usesWechatPay ? "预约已占位，完成微信支付后生效" : "预约已占位，完成模拟支付后生效")
          : "预约信息已经保存",
        description: awaitingPayment
          ? (usesWechatPay
            ? "检测站与时段已经暂时保留，请在订单详情完成微信支付。"
            : "检测站与时段已经暂时保留，请在订单详情完成本地模拟支付；不会产生真实扣款。")
          : "检测站、日期和服务方式都在订单中，后续步骤将读取这条预约的真实状态。",
        stateLabel: statusLabel(inProgress.status), tone: "active", iconPath: "/assets/icons/calendar-check.png",
        facts: [{ label: "预约车辆", value: plate }, { label: "检测站", value: inProgress.station?.name || "待确认" }, { label: "预约时间", value: orderTime(inProgress) }],
        tips: [{
          title: awaitingPayment ? (usesWechatPay ? "微信支付" : "本地模拟支付") : "查询与预约是两个动作",
          copy: awaitingPayment ? "继续按钮会进入当前订单，不会重新创建预约或重复占用号源。" : "规则测算只回答是否可能需要上线；当前订单才代表已占用检测站与时段。",
        }],
        primaryLabel: awaitingPayment ? (usesWechatPay ? "继续微信支付" : "继续模拟支付") : "查看预约详情",
        primaryAction: "order",
      };
    }
    return {
      stepNumber: "01", eyebrow: "在线预约", title: "选好时间和网点，预约就完成一半", description: "不确定是否需要上线时，先做规则测算；确认办理后再选择服务方式、检测站和时段。", stateLabel: order ? statusLabel(order.status) : "尚未预约", tone: order ? "attention" : "neutral", iconPath: "/assets/icons/calendar-check.png",
      facts: [{ label: "当前车辆", value: plate }, { label: "预约内容", value: "服务方式、检测站、日期与时段" }, { label: "可选方式", value: "自驾到站 / 上门代驾" }],
      tips: [{ title: "先查再约", copy: "“查询年检”提供规则测算和办理建议，不会自动创建订单。" }],
      primaryLabel: "立即预约", primaryAction: "book",
    };
  }

  if (step === "arrival") {
    if (usableOrder) {
      const isValet = usableOrder.serviceMode === "valet";
      const pickup = usableOrder.pickupAddress;
      return {
        stepNumber: "02", eyebrow: "到站验车", title: isValet ? "按取车安排完成车辆交接" : "按预约时间前往检测站", description: isValet ? "上门代驾订单由履约人员按已确认地址取送车辆，进度以订单事件为准。" : "建议提前 10–15 分钟到站，电话与导航均来自当前订单检测站。", stateLabel: statusLabel(usableOrder.status), tone: usableOrder.status === "completed" ? "success" : "active", iconPath: "/assets/icons/car.png",
        facts: isValet
          ? [{ label: "预约车辆", value: plate }, { label: "取车地址", value: pickup ? `${pickup.title} ${pickup.detail || ""}`.trim() : "请查看订单" }, { label: "预约时间", value: orderTime(usableOrder) }, { label: "车辆交接", value: "订单内查看取车与送回留证" }]
          : [{ label: "预约车辆", value: plate }, { label: "检测站", value: usableOrder.station?.name || "待确认" }, { label: "预约时间", value: orderTime(usableOrder) }, { label: "联系电话", value: usableOrder.station?.phone || "站点暂未提供" }],
        tips: [{ title: isValet ? "交车前确认" : "到站前确认", copy: isValet ? "贵重物品请提前取出，并与履约人员当面确认车况和钥匙交接。" : "带齐纸质随车材料、清理贵重物品，并保证车辆可正常检测。" }],
        primaryLabel: isValet || !usableOrder.station ? "查看预约详情" : "导航到检测站", primaryAction: isValet || !usableOrder.station ? "order" : "navigate",
      };
    }
    return {
      stepNumber: "02", eyebrow: "到站验车", title: "先预约，再获得准确的到站指引", description: "检测站、电话、路线和时间与具体订单绑定；没有预约时不展示虚构距离或导航。", stateLabel: "需先预约", tone: "neutral", iconPath: "/assets/icons/car.png",
      facts: [{ label: "当前车辆", value: plate }, { label: "现场流程", value: "到站核验 → 专业检测 → 结果回传" }, { label: "建议到达", value: "预约开始前 10–15 分钟" }],
      tips: [{ title: "路线口径", copy: "自驾按当前位置计算；上门代驾按取车地址计算，地图异常时会明确说明。" }],
      primaryLabel: "先预约年检", primaryAction: "book",
    };
  }

  if (step === "materials") {
    const mediaCount = usableOrder?.media?.length || 0;
    const ready = Boolean(usableOrder?.verification?.materialsReady);
    return {
      stepNumber: "03", eyebrow: "提交资料", title: usableOrder ? "资料随预约提交，核验状态以订单为准" : "预约时上传，随车材料到站前备齐", description: "线上照片和纸质随车材料分开说明，不用本地打勾冒充已经审核。", stateLabel: ready ? "资料已核验" : mediaCount ? `已上传 ${mediaCount} 项` : "预约时上传", tone: ready ? "success" : usableOrder ? "active" : "neutral", iconPath: "/assets/icons/file-arrow-up.png",
      facts: [
        { label: "机动车行驶证", value: "正副页完整、信息清晰" },
        { label: "有效期内交强险", value: "电子保单或可联网核验信息" },
        { label: "车船税信息", value: "完税或免税信息以现场核验为准" },
        { label: "三角警示牌", value: "随车携带，到站前确认" },
      ],
      tips: [{ title: "当前线上状态", copy: usableOrder ? `订单已保存 ${mediaCount} 项媒体资料，${ready ? "站点已确认材料齐备。" : "最终核验结果请查看订单详情。"}` : "自驾和代驾预约均需上传车身四角、启动后仪表盘和行驶证两页共 7 张；代驾司机取车时还会另拍 5 张履约留证。" }],
      primaryLabel: usableOrder ? "查看预约资料" : "去预约并提交资料", primaryAction: usableOrder ? "order" : "book",
    };
  }

  const conclusion = inspectionResultLabel(order);
  if (order?.inspectionResult) {
    const passed = order.inspectionResult.conclusion === "passed";
    const legacyUnconfirmed = order.inspectionResult.conclusionStatus === "legacy_requires_reentry";
    const advice = passed
      ? "可在交管12123查询检验有效期；符合条件时按官方入口申领检验标志。"
      : legacyUnconfirmed
        ? "旧版结论已停用，请联系检测站重新录入“通过”或“未通过”；此历史值不会自动算作未通过。"
        : "请联系检测站确认未通过项目、整改要求与复检安排，不要直接申领检验标志。";
    return {
      stepNumber: "04", eyebrow: "结果与申领", title: legacyUnconfirmed ? "本次正式检测结果尚未确认" : `本次检测结果：${conclusion}`, description: "页面只展示检测站回传的订单结果；检验有效期和标志状态以交管官方记录为准。", stateLabel: conclusion, tone: passed ? "success" : "attention", iconPath: "/assets/icons/shield-check.png",
      facts: [{ label: "预约车辆", value: plate }, { label: "检测站", value: order.station?.name || "机动车检测站" }, { label: "结果来源", value: order.inspectionResult.source }, { label: "回传时间", value: order.inspectionResult.receivedAt }],
      tips: [{ title: passed ? "后续申领" : "后续处理", copy: advice }],
      primaryLabel: order.vehicleCheckupReport ? "查看车辆体检报告" : "查看完整订单", primaryAction: order.vehicleCheckupReport ? "report" : "order",
    };
  }

  return {
    stepNumber: "04", eyebrow: "结果与申领", title: order ? "检测结果尚未回传" : "完成检测后，在这里查看真实结果", description: "驭小满不会伪造电子检验标志。结果回传后可查看结论，官方状态请在交管12123查询。", stateLabel: order ? statusLabel(order.status) : "等待办理", tone: order ? "active" : "neutral", iconPath: "/assets/icons/shield-check.png",
    facts: [{ label: "当前车辆", value: plate }, { label: "结果来源", value: "检测站订单结果回传" }, { label: "检验标志", value: "交管12123 官方查询" }],
    tips: [{ title: "真实边界", copy: "本页面只展示订单已有结果；没有合格结果时不显示申领入口，也不生成电子标。" }],
    primaryLabel: order ? "查看预约详情" : "查询是否需上线", primaryAction: order ? "order" : "eligibility",
  };
}

const EMPTY_STAGE = buildStage("booking", null, null);

Page<Data>({
  data: { step: "booking", loading: true, vehicle: null, order: null, stage: EMPTY_STAGE, stationPhone: "", showArrivalContact: false, resultPassed: false, usesWechatPay: false },
  onLoad(query) {
    const step = (["booking", "arrival", "materials", "result"].includes(query.step) ? query.step : "booking") as StepId;
    this.setData({ step });
    wx.setNavigationBarTitle({ title: ({ booking: "在线预约", arrival: "到站验车", materials: "提交资料", result: "结果与申领" })[step] });
    void this.loadPaymentChannel();
  },
  onShow() { void this.load(); },
  async loadPaymentChannel() {
    try {
      const info = await api.paymentProvider();
      const usesWechatPay = Boolean(info.wechatConfigured);
      this.setData({
        usesWechatPay,
        stage: buildStage(this.data.step, this.data.vehicle, this.data.order, usesWechatPay),
      });
    } catch {
      // Keep mock labels when provider probe fails.
    }
  },
  async load() {
    this.setData({ loading: true });
    try {
      const [vehicles, bookings] = await Promise.all([api.vehicles(), api.bookings()]);
      const vehicle = vehicles.find((item) => item.isDefault) || vehicles[0] || null;
      const latest = latestBooking(bookings);
      let order = latest;
      if (latest) order = await api.booking(latest.id).catch(() => latest);
      this.setData({
        vehicle,
        order,
        stage: buildStage(this.data.step, vehicle, order, this.data.usesWechatPay),
        stationPhone: order?.station?.phone || "",
        showArrivalContact: this.data.step === "arrival" && order?.serviceMode === "self_drive" && Boolean(order?.station?.phone),
        resultPassed: this.data.step === "result" && order?.inspectionResult?.conclusion === "passed",
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "读取年检进度失败", icon: "none" });
      this.setData({ stage: buildStage(this.data.step, null, null, this.data.usesWechatPay) });
    } finally {
      this.setData({ loading: false });
    }
  },
  runAction(event) {
    const action = String(event.currentTarget.dataset.action || "") as StageAction;
    if (action === "book") wx.navigateTo({ url: "/packages/annual/pages/service-mode/service-mode" });
    else if (action === "eligibility") wx.navigateTo({ url: "/packages/annual/pages/eligibility/eligibility" });
    else if (action === "orders") wx.switchTab({ url: "/pages/orders/orders" });
    else if (action === "report") {
      if (this.data.order?.vehicleCheckupReport) wx.navigateTo({ url: `/packages/inspection/pages/checkup-report/checkup-report?id=${encodeURIComponent(this.data.order.id)}` });
      else wx.showToast({ title: "当前订单还没有车辆体检报告", icon: "none" });
    }
    else if (action === "order") {
      if (this.data.order) wx.navigateTo({ url: `/packages/annual/pages/order-detail/order-detail?id=${encodeURIComponent(this.data.order.id)}` });
      else wx.switchTab({ url: "/pages/orders/orders" });
    } else if (action === "navigate") {
      const station = this.data.order?.station;
      if (station) wx.openLocation({ latitude: station.latitude, longitude: station.longitude, name: station.name, address: station.address, scale: 16 });
      else wx.showToast({ title: "当前订单还没有检测站位置", icon: "none" });
    }
  },
  callStation() {
    if (this.data.stationPhone) wx.makePhoneCall({ phoneNumber: this.data.stationPhone });
  },
  officialGuide() {
    wx.showModal({
      title: "交管12123 申领指引",
      content: "请打开“交管12123”App，在机动车业务中查看检验有效期与检验标志电子凭证；如页面提供申领入口，请按官方提示办理。最终状态以官方记录为准。",
      confirmText: "我知道了",
      success: () => undefined,
    });
  },
});
