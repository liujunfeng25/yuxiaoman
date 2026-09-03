import { repairOperatorApi } from "../../services/operator-api";
import {
  ensureRepairOperatorPageAccess,
  isDemoRepairOperatorSubject,
  readRepairOperatorSession,
} from "../../services/operator-session";
import {
  fenToYuanInput,
  formatFenAmount,
  normalizeQuoteNote,
  normalizeRepairRequest,
  validateShopQuote,
  yuanInputToFen,
  type RepairShopRequestDto,
} from "../../utils/shop-model";

type Data = {
  id: string;
  shopName: string;
  isDemoShop: boolean;
  request: RepairShopRequestDto | null;
  totalInput: string;
  totalPreview: string;
  noteInput: string;
  priceError: string;
  noteError: string;
  hasActiveQuote: boolean;
  loading: boolean;
  submitting: boolean;
  withdrawing: boolean;
  error: string;
};

Page<Data>({
  data: {
    id: "",
    shopName: "维修门店",
    isDemoShop: false,
    request: null,
    totalInput: "",
    totalPreview: "--",
    noteInput: "",
    priceError: "",
    noteError: "",
    hasActiveQuote: false,
    loading: true,
    submitting: false,
    withdrawing: false,
    error: "",
  },

  onLoad(query) {
    const id = query.id || "";
    const returnUrl = `/packages/repair/pages/shop-quote/shop-quote${id ? `?id=${encodeURIComponent(id)}` : ""}`;
    if (!ensureRepairOperatorPageAccess(returnUrl)) return;
    const session = readRepairOperatorSession();
    this.setData({
      id,
      shopName: session?.subject.name || "维修门店",
      isDemoShop: isDemoRepairOperatorSubject(session?.subject),
    });
    if (query.id) void this.load();
    else this.setData({ loading: false, error: "缺少维修需求编号" });
  },

  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const request = normalizeRepairRequest(await repairOperatorApi.repairShopRequest(this.data.id));
      const activeQuote = request.myQuote?.status === "active" ? request.myQuote : null;
      const totalFen = activeQuote?.totalFen ?? null;
      const noteInput = activeQuote?.note || "";
      this.setData({
        request,
        totalInput: fenToYuanInput(totalFen),
        totalPreview: formatFenAmount(totalFen),
        noteInput,
        hasActiveQuote: Boolean(activeQuote),
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "读取报价信息失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  totalInput(event) {
    const totalInput = String(event.detail.value || "");
    const amount = yuanInputToFen(totalInput);
    this.setData({
      totalInput,
      totalPreview: amount.fen === null ? "--" : formatFenAmount(amount.fen),
      priceError: amount.valid || !totalInput ? "" : amount.error,
    });
  },

  noteInput(event) {
    const noteInput = String(event.detail.value || "");
    this.setData({ noteInput, noteError: noteInput.trim() ? "" : "请填写一句报价说明" });
  },

  noteBlur() { this.setData({ noteInput: normalizeQuoteNote(this.data.noteInput) }); },

  async submit() {
    if (this.data.submitting || this.data.withdrawing) return;
    const request = this.data.request;
    if (!request) return;
    if (["won", "not_selected", "closed"].includes(request.status)) {
      wx.showToast({ title: "当前需求已不能报价", icon: "none" });
      return;
    }
    const validation = validateShopQuote(this.data.totalInput, this.data.noteInput);
    this.setData({ priceError: validation.priceError, noteError: validation.noteError, noteInput: validation.note });
    if (validation.priceError || validation.noteError || validation.totalFen === null) return;

    const signature = `${request.id}:${validation.totalFen}:${validation.note}`;
    if (this.submissionSignature !== signature) {
      this.submissionSignature = signature;
      this.submissionKey = `repair-quote-${request.id}-${Date.now()}`;
    }
    this.setData({ submitting: true, error: "" });
    try {
      const wasUpdate = this.data.hasActiveQuote;
      const updated = normalizeRepairRequest(await repairOperatorApi.submitRepairShopQuote(request.id, {
        totalFen: validation.totalFen,
        note: validation.note,
        idempotencyKey: this.submissionKey,
      }));
      this.setData({ request: updated, hasActiveQuote: true });
      wx.showToast({ title: wasUpdate ? "报价已更新" : "报价已提交", icon: "success" });
      setTimeout(() => wx.navigateBack(), 350);
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "报价提交失败，请重试" });
    } finally {
      this.setData({ submitting: false });
    }
  },

  withdraw() {
    if (!this.data.request || !this.data.hasActiveQuote || this.data.submitting || this.data.withdrawing) return;
    wx.showModal({
      title: "撤回本店报价？",
      content: "撤回后车主将无法选择这份报价，可在需求仍开放时重新提交。",
      confirmText: "确认撤回",
      confirmColor: "#d14b4b",
      success: (result) => { if (result.confirm) void this.confirmWithdraw(); },
    });
  },

  async confirmWithdraw() {
    const request = this.data.request;
    if (!request || this.data.withdrawing) return;
    this.setData({ withdrawing: true, error: "" });
    try {
      const updated = normalizeRepairRequest(await repairOperatorApi.withdrawRepairShopQuote(request.id));
      this.setData({ request: updated, hasActiveQuote: false });
      wx.showToast({ title: "报价已撤回", icon: "success" });
      setTimeout(() => wx.navigateBack(), 350);
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "撤回失败，请重试" });
    } finally {
      this.setData({ withdrawing: false });
    }
  },

  retry() { void this.load(); },
});
