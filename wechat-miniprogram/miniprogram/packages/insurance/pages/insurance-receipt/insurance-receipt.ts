import { api } from "../../../../services/api";
import { getInsuranceReceipt, storeInsuranceReceipt } from "../../../../services/storage";
import type { InsuranceLeadReceipt } from "../../../../types";

type Data = {
  receipt: InsuranceLeadReceipt | null;
  submittedAtText: string;
  withdrawn: boolean;
  withdrawing: boolean;
  error: string;
};

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "--";
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

Page<Data>({
  data: {
    receipt: null,
    submittedAtText: "",
    withdrawn: false,
    withdrawing: false,
    error: "",
  },

  onShow() {
    const receipt = getInsuranceReceipt();
    if (!receipt?.leadCode) {
      this.setData({ receipt: null, submittedAtText: "", withdrawn: false });
      return;
    }
    this.setData({
      receipt,
      submittedAtText: localDateTime(receipt.submittedAt),
      withdrawn: receipt.status === "withdrawn",
      error: "",
    });
  },

  copyCode() {
    const leadCode = this.data.receipt?.leadCode;
    if (!leadCode) return;
    wx.setClipboardData({
      data: leadCode,
      success: () => wx.showToast({ title: "凭证编号已复制", icon: "success" }),
      fail: () => wx.showToast({ title: `凭证编号：${leadCode}`, icon: "none" }),
    });
  },

  withdraw() {
    const receipt = this.data.receipt;
    if (!receipt?.withdrawToken || this.data.withdrawing || this.data.withdrawn) return;
    wx.showModal({
      title: "撤回本次需求？",
      content: "撤回后平台将停止后续对接；若资料已完成转交，将按授权说明继续处理清理请求。",
      confirmText: "确认撤回",
      confirmColor: "#B84254",
      success: (result) => {
        if (result.confirm) void this.confirmWithdraw();
      },
    });
  },

  async confirmWithdraw() {
    const receipt = this.data.receipt;
    if (!receipt?.withdrawToken || this.data.withdrawing || this.data.withdrawn) return;
    this.setData({ withdrawing: true, error: "" });
    try {
      const updated = await api.withdrawInsuranceLead(receipt.withdrawToken);
      const nextReceipt = updated.leadCode ? updated : { ...receipt, status: "withdrawn" };
      storeInsuranceReceipt(nextReceipt);
      this.setData({
        receipt: nextReceipt,
        submittedAtText: localDateTime(nextReceipt.submittedAt),
        withdrawn: true,
      });
      wx.showToast({ title: "续保对接需求已撤回", icon: "success" });
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
