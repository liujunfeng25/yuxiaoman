import { repairOperatorApi } from "../../services/operator-api";
import {
  localizeRepairOperatorMedia,
  repairOperatorMediaSourceUrl,
} from "../../services/operator-media";
import {
  ensureRepairOperatorPageAccess,
  isDemoRepairOperatorSubject,
  readRepairOperatorSession,
} from "../../services/operator-session";
import {
  formatFenAmount,
  normalizeRepairRequest,
  shopStatusLabel,
  type RepairFaultDto,
  type RepairShopRequestDto,
} from "../../utils/shop-model";

type FaultView = RepairFaultDto & { sequence: number; photoSourceUrls: string[]; photoCountLabel: string; severityTone: "minor" | "moderate" | "severe" };

type Data = {
  id: string;
  shopName: string;
  isDemoShop: boolean;
  request: RepairShopRequestDto | null;
  faults: FaultView[];
  quoteAmountLabel: string;
  requestStatusLabel: string;
  quoteStatusLabel: string;
  quoteActionLabel: string;
  loading: boolean;
  error: string;
};

Page<Data>({
  data: {
    id: "",
    shopName: "维修门店",
    isDemoShop: false,
    request: null,
    faults: [],
    quoteAmountLabel: "",
    requestStatusLabel: "",
    quoteStatusLabel: "",
    quoteActionLabel: "去报价",
    loading: true,
    error: "",
  },

  onLoad(query) {
    const id = query.id || "";
    const returnUrl = `/packages/repair/pages/shop-request-detail/shop-request-detail${id ? `?id=${encodeURIComponent(id)}` : ""}`;
    if (!ensureRepairOperatorPageAccess(returnUrl)) return;
    const session = readRepairOperatorSession();
    this.setData({
      id,
      shopName: session?.subject.name || "维修门店",
      isDemoShop: isDemoRepairOperatorSubject(session?.subject),
    });
  },

  onShow() {
    if (!ensureRepairOperatorPageAccess(`/packages/repair/pages/shop-request-detail/shop-request-detail?id=${encodeURIComponent(this.data.id)}`)) return;
    if (this.data.id) void this.load();
    else this.setData({ loading: false, error: "缺少维修需求编号" });
  },

  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const request = normalizeRepairRequest(await repairOperatorApi.repairShopRequest(this.data.id));
      const faults: FaultView[] = await Promise.all(request.faults.map(async (fault, index) => {
        const photoSourceUrls = fault.photoUrls.map((path) => repairOperatorMediaSourceUrl(path));
        const photoUrls = await Promise.all(photoSourceUrls.map((path) => localizeRepairOperatorMedia(path).catch(() => "")));
        return {
          ...fault,
          sequence: index + 1,
          photoSourceUrls,
          photoUrls,
          photoCountLabel: photoSourceUrls.length ? `${photoSourceUrls.length} 张特写` : "暂无特写",
          severityTone: fault.severityLabel === "轻微" ? "minor" as const : fault.severityLabel === "明显" ? "severe" as const : "moderate" as const,
        };
      }));
      const quote = request.myQuote?.status === "active" ? request.myQuote : null;
      this.setData({
        request: { ...request, faults },
        faults,
        requestStatusLabel: shopStatusLabel(request.status),
        quoteAmountLabel: quote ? formatFenAmount(quote.totalFen) : "",
        quoteStatusLabel: quote ? (request.status === "won" ? "已成交" : "已提交") : request.myQuote?.status === "withdrawn" ? "已撤回" : "待报价",
        quoteActionLabel: request.status === "won" ? "查看成交与联系人" : quote ? "修改本店报价" : "填写本店报价",
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "读取维修需求失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  previewPhoto(event) {
    const faultId = event.currentTarget.dataset.faultId as string;
    const current = event.currentTarget.dataset.url as string;
    const fault = this.data.faults.find((item) => item.id === faultId);
    const urls = fault?.photoUrls.filter(Boolean) || [];
    if (!current || !urls.length) return;
    wx.previewImage({ current, urls });
  },

  async handlePhotoTap(event) {
    const faultId = String(event.currentTarget.dataset.faultId || "");
    const photoIndex = Number(event.currentTarget.dataset.photoIndex);
    const current = String(event.currentTarget.dataset.url || "");
    if (current) {
      this.previewPhoto(event);
      return;
    }
    await this.recoverPrivatePhoto(faultId, photoIndex);
  },

  async handlePrivatePhotoError(event) {
    await this.recoverPrivatePhoto(
      String(event.currentTarget.dataset.faultId || ""),
      Number(event.currentTarget.dataset.photoIndex),
    );
  },

  async recoverPrivatePhoto(faultId: string, photoIndex: number) {
    const fault = this.data.faults.find((item) => item.id === faultId);
    const sourceUrl = fault?.photoSourceUrls[photoIndex];
    if (!fault || !sourceUrl || !Number.isInteger(photoIndex)) return;
    try {
      const url = await localizeRepairOperatorMedia(sourceUrl, { forceRefresh: true });
      const faults = this.data.faults.map((item) => item.id === faultId
        ? { ...item, photoUrls: item.photoUrls.map((photo, index) => index === photoIndex ? url : photo) }
        : item);
      this.setData({ faults, request: this.data.request ? { ...this.data.request, faults } : null });
    } catch {
      wx.showToast({ title: "照片重新读取失败", icon: "none" });
    }
  },

  primaryAction() {
    const request = this.data.request;
    if (!request) return;
    const page = request.status === "won" ? "shop-deal" : "shop-quote";
    wx.navigateTo({
      url: `/packages/repair/pages/${page}/${page}?id=${encodeURIComponent(request.id)}`,
    });
  },

  retry() { void this.load(); },
});
