import { api } from "../../../../services/api";
import { getSubsidyConsultationReceipt, storeSubsidyConsultationReceipt } from "../../../../services/storage";
import type { SubsidyConsultationReceipt } from "../../../../types";
import {
  formatDeclaredValue,
  formatSubsidyFeeBreakdown,
  tierRangeText,
  type SubsidyFeeBreakdownText,
} from "../../utils/consultation";

type Data = {
  consultationId: string;
  receipt: SubsidyConsultationReceipt | null;
  loading: boolean;
  error: string;
  statusLabel: string;
  statusTitle: string;
  statusCopy: string;
  statusIcon: string;
  statusTone: string;
  canWithdraw: boolean;
  withdrawing: boolean;
  submittedAtText: string;
  declaredValueText: string;
  tierText: string;
  feeBreakdown: SubsidyFeeBreakdownText | null;
};

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "--";
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function statusView(receipt: SubsidyConsultationReceipt) {
  if (receipt.status === "withdrawn") return {
    statusLabel: "咨询已撤回",
    statusTitle: "本次咨询已停止",
    statusCopy: "平台已停止后续联系，敏感资料将按信息使用说明进入清理流程。",
    statusIcon: "/assets/icons/x.png",
    statusTone: "muted",
    canWithdraw: false,
  };
  if (receipt.status === "handled") return {
    statusLabel: "咨询已处理",
    statusTitle: "服务人员已完成联系处理",
    statusCopy: "本凭证仅记录咨询处理，不代表补贴资格、官方申报或补贴结果。",
    statusIcon: "/assets/icons/check-circle.png",
    statusTone: "handled",
    canWithdraw: false,
  };
  if (receipt.status === "expired") return {
    statusLabel: "咨询已过期",
    statusTitle: "本次咨询已结束",
    statusCopy: "如仍需咨询，请返回首页按后台当前价格重新提交。",
    statusIcon: "/assets/icons/clock.png",
    statusTone: "muted",
    canWithdraw: false,
  };
  return {
    statusLabel: "提交成功",
    statusTitle: "已生成补贴咨询凭证",
    statusCopy: `${receipt.contactEtaText || "1个工作日内联系"}，请留意来电。`,
    statusIcon: "/assets/icons/check-circle.png",
    statusTone: "active",
    canWithdraw: receipt.canWithdraw,
  };
}

Page<Data>({
  data: {
    consultationId: "",
    receipt: null,
    loading: true,
    error: "",
    statusLabel: "",
    statusTitle: "",
    statusCopy: "",
    statusIcon: "/assets/icons/check-circle.png",
    statusTone: "active",
    canWithdraw: false,
    withdrawing: false,
    submittedAtText: "",
    declaredValueText: "",
    tierText: "",
    feeBreakdown: null,
  },

  onLoad(options: Record<string, string | undefined>) {
    const cached = getSubsidyConsultationReceipt();
    const consultationId = String(options.id || cached?.id || "");
    if (cached?.id === consultationId) this.applyReceipt(cached);
    this.setData({ consultationId, loading: Boolean(consultationId), error: "" });
    if (consultationId) void this.loadReceipt();
    else this.setData({ loading: false });
  },

  applyReceipt(receipt: SubsidyConsultationReceipt) {
    this.setData({
      receipt,
      ...statusView(receipt),
      submittedAtText: localDateTime(receipt.submittedAt),
      declaredValueText: formatDeclaredValue(receipt.declaredValueFen),
      tierText: `${receipt.matchedTier.label}（${tierRangeText(receipt.matchedTier)}）`,
      feeBreakdown: formatSubsidyFeeBreakdown(receipt),
    });
  },

  async loadReceipt() {
    try {
      const receipt = await api.subsidyConsultation(this.data.consultationId);
      storeSubsidyConsultationReceipt(receipt);
      this.applyReceipt(receipt);
      this.setData({ error: "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "咨询凭证读取失败";
      this.setData({ error: message });
    } finally {
      this.setData({ loading: false });
    }
  },

  retry() {
    if (!this.data.consultationId) return;
    this.setData({ loading: true, error: "" });
    void this.loadReceipt();
  },

  copyCode() {
    const code = this.data.receipt?.consultationCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: "咨询编号已复制", icon: "success" }),
      fail: () => wx.showToast({ title: `咨询编号：${code}`, icon: "none" }),
    });
  },

  withdraw() {
    if (!this.data.canWithdraw || this.data.withdrawing) return;
    wx.showModal({
      title: "撤回本次咨询？",
      content: "撤回后平台将停止后续联系，敏感资料将按信息使用说明进入清理流程。",
      confirmText: "确认撤回",
      confirmColor: "#B84254",
      success: (result) => {
        if (result.confirm) void this.confirmWithdraw();
      },
    });
  },

  async confirmWithdraw() {
    if (!this.data.consultationId || !this.data.canWithdraw || this.data.withdrawing) return;
    this.setData({ withdrawing: true, error: "" });
    try {
      const receipt = await api.withdrawSubsidyConsultation(this.data.consultationId);
      storeSubsidyConsultationReceipt(receipt);
      this.applyReceipt(receipt);
      wx.showToast({ title: "咨询已撤回", icon: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "撤回失败，请稍后重试";
      this.setData({ error: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ withdrawing: false });
    }
  },

  backHome() {
    wx.switchTab({ url: "/pages/home/home" });
  },
});
