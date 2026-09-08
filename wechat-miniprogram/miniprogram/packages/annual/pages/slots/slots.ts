import { api } from "../../../../services/api";
import { getBookingDraft, patchBookingDraft } from "../../../../services/storage";
import type { BookingDraft, Slot, Station } from "../../../../types";
declare function getCurrentPages(): unknown[];
type Data = {
  station: Station | null;
  slots: Slot[];
  loading: boolean;
  loadError: string;
  navigatingSlotId: string;
  referenceFeeFen: number;
  referenceFeeNote: string;
  quotingFee: boolean;
};
Page<Data>({
  data: {
    station: null,
    slots: [],
    loading: true,
    loadError: "",
    navigatingSlotId: "",
    referenceFeeFen: 0,
    referenceFeeNote: "精确价格将在下一页根据车辆信息重新核算",
    quotingFee: false,
  },
  async onLoad(query) {
    const draft = getBookingDraft();
    const station = draft?.station;
    if (!station || station.id !== query.stationId) {
      this.setData({ loading: false, loadError: "预约草稿中的检测站已失效，请返回重新选择。" });
      return;
    }
    this.setData({
      station,
      referenceFeeFen: station.serviceFeeFen,
      referenceFeeNote: "精确价格将在下一页根据车辆信息重新核算",
    });
    await Promise.all([this.loadSlots(), this.loadReferenceFee(draft)]);
  },
  onShow() { if (this.data.navigatingSlotId) this.setData({ navigatingSlotId: "" }); },
  async loadReferenceFee(draft: BookingDraft | null = getBookingDraft()) {
    const station = this.data.station || draft?.station;
    const vehicleId = draft?.vehicleId || "";
    if (!station || !vehicleId) return;
    this.setData({ quotingFee: true });
    try {
      const quote = await api.quote({
        vehicleId,
        stationId: station.id,
        serviceMode: draft?.serviceMode || "self_drive",
        pickupAddress: draft?.pickupAddress,
        originLat: draft?.origin?.latitude,
        originLng: draft?.origin?.longitude,
        originType: draft?.origin?.type,
      });
      // 时段页只展示年检服务费，与确认页「年检服务费」对齐；代驾费仍在下一页核算。
      this.setData({
        referenceFeeFen: quote.inspectionFeeFen,
        referenceFeeNote: "已按当前车辆核算年检服务费；代驾等费用在下一页确认",
      });
    } catch {
      this.setData({
        referenceFeeFen: station.serviceFeeFen,
        referenceFeeNote: "暂时无法按车辆核算，以下为站点挂牌参考价；精确价格将在下一页重新核算",
      });
    } finally {
      this.setData({ quotingFee: false });
    }
  },
  async loadSlots() {
    const station = this.data.station;
    if (!station) return;
    this.setData({ loading: true, loadError: "" });
    try { this.setData({ slots: await api.slots(station.id), loadError: "" }); }
    catch (error) {
      this.setData({ slots: [], loadError: error instanceof Error ? error.message : "读取号源失败，请稍后重试" });
      wx.showToast({ title: "号源读取失败", icon: "none" });
    }
    finally { this.setData({ loading: false }); }
  },
  retry() {
    if (this.data.loading || this.data.quotingFee) return;
    void Promise.all([this.loadSlots(), this.loadReferenceFee()]);
  },
  goBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    const draft = getBookingDraft();
    const serviceMode = draft?.serviceMode || "self_drive";
    const vehicleId = draft?.vehicleId ? `&vehicleId=${encodeURIComponent(draft.vehicleId)}` : "";
    wx.redirectTo({ url: `/packages/annual/pages/stations/stations?serviceMode=${serviceMode}${vehicleId}` });
  },
  choose(event) {
    if (this.data.navigatingSlotId) return;
    const slot = this.data.slots.find((item) => item.id === event.currentTarget.dataset.id);
    if (!slot || slot.remaining <= 0) return;
    patchBookingDraft({ slot });
    this.setData({ navigatingSlotId: slot.id });
    wx.navigateTo({ url: "/packages/annual/pages/booking/booking" });
    setTimeout(() => {
      if (this.data.navigatingSlotId === slot.id) this.setData({ navigatingSlotId: "" });
    }, 1200);
  },
});
