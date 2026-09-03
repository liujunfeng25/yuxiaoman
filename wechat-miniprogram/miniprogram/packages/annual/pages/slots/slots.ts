import { api } from "../../../../services/api";
import { getBookingDraft, patchBookingDraft } from "../../../../services/storage";
import type { Slot, Station } from "../../../../types";
declare function getCurrentPages(): unknown[];
type Data = { station: Station | null; slots: Slot[]; loading: boolean; loadError: string; navigatingSlotId: string };
Page<Data>({
  data: { station: null, slots: [], loading: true, loadError: "", navigatingSlotId: "" },
  async onLoad(query) {
    const station = getBookingDraft()?.station;
    if (!station || station.id !== query.stationId) { this.setData({ loading: false, loadError: "预约草稿中的检测站已失效，请返回重新选择。" }); return; }
    this.setData({ station });
    await this.loadSlots();
  },
  onShow() { if (this.data.navigatingSlotId) this.setData({ navigatingSlotId: "" }); },
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
  retry() { if (!this.data.loading) void this.loadSlots(); },
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
