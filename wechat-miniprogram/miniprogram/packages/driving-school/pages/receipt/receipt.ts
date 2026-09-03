import { api } from "../../../../services/api";
import { getDrivingSchoolReceipt, storeDrivingSchoolReceipt } from "../../../../services/storage";
import type { DrivingSchoolInquiryReceipt } from "../../../../types";
import { applicationModeLabel, dateTimeText, errorKind } from "../../utils";

type ReceiptView = DrivingSchoolInquiryReceipt & {
  applicationModeText: string;
  submittedAtText: string;
  statusText: string;
  withdrawn: boolean;
  canWithdraw: boolean;
};

type Data = {
  receipt: ReceiptView | null;
  withdrawing: boolean;
  error: string;
  stateKind: "offline" | "not_found" | "error" | "";
};

function view(receipt: DrivingSchoolInquiryReceipt): ReceiptView {
  const withdrawn = receipt.status === "withdrawn";
  const statusText = ({ new: "待联系", contacting: "联系中", resolved: "已解决", closed: "已关闭", withdrawn: "已撤回" } as Record<string, string>)[receipt.status] || "状态待确认";
  const canWithdraw = receipt.status === "new" || receipt.status === "contacting";
  return { ...receipt, applicationModeText: applicationModeLabel(receipt.applicationMode), submittedAtText: dateTimeText(receipt.submittedAt), statusText, withdrawn, canWithdraw };
}

Page<Data>({
  data: { receipt: null, withdrawing: false, error: "", stateKind: "" },

  onShow() {
    const receipt = getDrivingSchoolReceipt();
    this.setData({ receipt: receipt?.inquiryCode ? view(receipt) : null, error: "", stateKind: "" });
  },

  copyCode() {
    const code = this.data.receipt?.inquiryCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: "凭证编号已复制", icon: "success" }),
      fail: () => wx.showToast({ title: `凭证：${code}`, icon: "none" }),
    });
  },
  withdraw() {
    const receipt = this.data.receipt;
    if (!receipt?.withdrawToken || !receipt.canWithdraw || this.data.withdrawing) return;
    wx.showModal({
      title: "撤回本次驾校咨询？",
      content: "撤回后，平台将停止后续联系和内部跟进，且不能恢复；凭证会保留撤回状态。",
      confirmText: "确认撤回",
      confirmColor: "#B84254",
      success: ({ confirm }) => { if (confirm) void this.confirmWithdraw(); },
    });
  },
  async confirmWithdraw() {
    const receipt = this.data.receipt;
    if (!receipt?.withdrawToken || !receipt.canWithdraw || this.data.withdrawing) return;
    this.setData({ withdrawing: true, error: "", stateKind: "" });
    try {
      const updated = await api.withdrawDrivingSchoolInquiry(receipt.withdrawToken);
      const normalized = updated.inquiryCode ? updated : { ...receipt, status: "withdrawn" };
      storeDrivingSchoolReceipt(normalized);
      this.setData({ receipt: view(normalized) });
      wx.showToast({ title: "咨询已撤回", icon: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "撤回失败，请稍后重试";
      this.setData({ error: message, stateKind: errorKind(error) });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ withdrawing: false });
    }
  },
  browseSchools() { wx.redirectTo({ url: "/packages/driving-school/pages/list/list" }); },
  backHome() { wx.switchTab({ url: "/pages/home/home" }); },
});
