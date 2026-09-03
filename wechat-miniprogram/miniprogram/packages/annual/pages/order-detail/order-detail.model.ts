import type { Booking } from "../../../../types";

export type QuoteClockView = { expired: boolean; text: string };
export type BookingQuoteView = {
  paymentPending: boolean;
  payableFen: number;
  paymentSummaryLabel: string;
  paymentSummaryFen: number;
  refundedFen: number;
  snapshotText: string;
  routeSummaryText: string;
  pricingFormulaText: string;
};
export type BookingPaymentStateView = {
  title: string;
  copy: string;
  tone: "pending" | "paid" | "refunded" | "unpaid" | "unknown";
};

export function bookingPaymentPending(booking: Booking): boolean {
  return booking.status === "pending_payment"
    && booking.paymentStatus !== "paid"
    && booking.paymentStatus !== "refunded";
}

function money(fen: number): string { return (Number(fen || 0) / 100).toFixed(2); }
function pad(value: number): string { return String(value).padStart(2, "0"); }

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "截止时间无效";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function quoteClockView(expiresAt: string | null | undefined, now = Date.now()): QuoteClockView {
  if (!expiresAt) return { expired: false, text: "历史订单未记录报价截止时间" };
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return { expired: true, text: "报价已过期" };
  const remainingSeconds = Math.max(0, Math.ceil((expires - now) / 1000));
  if (remainingSeconds <= 0) return { expired: true, text: `报价已过期（原有效期至 ${formatExpiry(expiresAt)}）` };
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return {
    expired: false,
    text: `有效至 ${formatExpiry(expiresAt)}（剩余 ${minutes}:${pad(seconds)}）`,
  };
}

export function bookingQuoteView(booking: Booking): BookingQuoteView {
  const paymentPending = bookingPaymentPending(booking);
  const payableFen = Number(booking.amountDueFen ?? booking.chargedFen ?? booking.serviceFeeFen ?? 0);
  const chargedFen = Math.max(0, Number(booking.chargedFen ?? booking.serviceFeeFen ?? 0));
  const recordedPaidFen = Math.max(0, Number(booking.paidFen ?? 0));
  const hasRecordedPayment = recordedPaidFen > 0
    || booking.paymentStatus === "paid"
    || booking.paymentStatus === "partially_refunded"
    || booking.paymentStatus === "refunded";
  const paidFen = recordedPaidFen > 0 ? recordedPaidFen : (hasRecordedPayment ? chargedFen : 0);
  const paymentSummaryLabel = paymentPending
    ? "当前待付"
    : hasRecordedPayment
      ? "已模拟支付"
      : payableFen > 0
        ? "当前待付"
        : "订单累计应收";
  const paymentSummaryFen = paymentPending
    ? payableFen
    : hasRecordedPayment
      ? paidFen
      : chargedFen;
  const refundedFen = Math.max(0, Number(booking.refundedFen ?? 0));
  const snapshotText = booking.quoteSnapshotId || "未记录";
  if (booking.serviceMode !== "valet") {
    return {
      paymentPending,
      payableFen,
      paymentSummaryLabel,
      paymentSummaryFen,
      refundedFen,
      snapshotText,
      routeSummaryText: "",
      pricingFormulaText: "",
    };
  }
  const distance = booking.oneWayDistanceKm ?? booking.quoteDistanceKm;
  const routeSummaryText = distance == null
    ? "当前订单未记录可核验的驾车路线"
    : booking.quoteSource === "tencent_matrix"
      ? `腾讯驾车单程路线 ${Number(distance).toFixed(1)} km；返程已包含，不重复收费`
      : `历史路线 ${Number(distance).toFixed(1)} km（非腾讯实时驾车路线）`;
  const rule = booking.valetRule;
  const pricingFormulaText = rule
    ? `往返取送费 = ¥${money(rule.baseFeeFen)} + 超出 ${Number(booking.extraKm ?? 0)} km × ¥${money(rule.perKmFen)} = ¥${money(booking.valetFeeFen)}`
    : `往返取送费 ¥${money(booking.valetFeeFen)}（历史订单未记录完整计价公式）`;
  return {
    paymentPending,
    payableFen,
    paymentSummaryLabel,
    paymentSummaryFen,
    refundedFen,
    snapshotText,
    routeSummaryText,
    pricingFormulaText,
  };
}

export function bookingPaymentStateView(booking: Booking): BookingPaymentStateView {
  if (booking.paymentStatus === "paid") {
    if (booking.status === "pending_precheck") {
      return {
        title: "本地模拟支付已确认",
        copy: "订单已提交检测站照片预审；预审通过后才会进入车辆履约流程。",
        tone: "paid",
      };
    }
    return {
      title: "本地模拟支付已确认",
      copy: "该金额已计入模拟应收、已收和后台统计。",
      tone: "paid",
    };
  }
  if (booking.paymentStatus === "partially_refunded") {
    return {
      title: "本地模拟支付已部分退款",
      copy: "支付与退款金额分别展示；记录仅用于演示，不涉及真实资金流转。",
      tone: "refunded",
    };
  }
  if (booking.paymentStatus === "refunded") {
    return {
      title: "本地模拟款项已退款",
      copy: "退款仅更新演示交易记录，不涉及真实资金流转。",
      tone: "refunded",
    };
  }
  if (booking.status === "pending_payment") {
    return {
      title: "待完成本地模拟支付",
      copy: "支付成功后订单将进入检测站照片预审，预审通过后再开始履约。",
      tone: "pending",
    };
  }
  if (booking.paymentStatus === "unpaid") {
    return {
      title: "模拟支付未完成",
      copy: booking.status === "cancelled"
        ? "该预约已取消，未产生模拟支付记录。"
        : "当前订单未记录已支付金额，请以订单状态和后台记录为准。",
      tone: "unpaid",
    };
  }
  return {
    title: "支付状态待同步",
    copy: "该历史订单未提供完整支付状态，请以后台交易记录为准。",
    tone: "unknown",
  };
}

export function quoteAmountChanged(before: Booking, after: Booking): boolean {
  return Number(before.serviceFeeFen || 0) !== Number(after.serviceFeeFen || 0);
}
