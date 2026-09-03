import { api } from "../../../../services/api";
import { ensureOperatorPageAccess } from "../../../../services/operator-session";
import type { Slot, Station } from "../../../../types";
import { today } from "../../../../utils/format";

type SlotView = Slot & { booked: number; timeLabel: string; occupancyLabel: string; occupancyTone: "high" | "medium" | "low" };
type Data = {
  station: Station | null;
  stationName: string;
  slots: SlotView[];
  date: string;
  loading: boolean;
  savingId: string;
  accessReady: boolean;
};

function slotView(item: Slot): SlotView {
  const booked = Math.max(0, item.capacity - item.remaining);
  const occupancy = item.capacity ? booked / item.capacity : 0;
  return {
    ...item,
    booked,
    timeLabel: `${item.startTime}–${item.endTime}`,
    occupancyLabel: occupancy >= .8 ? "紧张" : occupancy >= .5 ? "适中" : "充足",
    occupancyTone: occupancy >= .8 ? "high" : occupancy >= .5 ? "medium" : "low",
  };
}

Page<Data>({
  data: { station: null, stationName: "站点号源", slots: [], date: today(), loading: true, savingId: "", accessReady: false },
  async onLoad(query) {
    const id = String(query.id || "");
    const accessReady = ensureOperatorPageAccess(`/packages/operator/pages/operator-station/operator-station?id=${encodeURIComponent(id)}`);
    this.setData({ accessReady });
    if (!accessReady) return;
    await this.loadSlots();
  },
  async loadSlots() {
    this.setData({ loading: true });
    try {
      const workbench = await api.operatorWorkbench(this.data.station?.id, this.data.date);
      const slots: Slot[] = workbench.pressure.map((item) => ({
        id: item.slotId,
        stationId: workbench.station.id,
        date: workbench.businessDate,
        startTime: item.startTime,
        endTime: item.endTime,
        capacity: item.capacity,
        remaining: item.remaining,
      }));
      this.setData({
        station: workbench.station,
        stationName: workbench.station.name.replace("（演示）", ""),
        slots: slots.map(slotView),
      });
    } catch (error) {
      if (!ensureOperatorPageAccess(`/packages/operator/pages/operator-station/operator-station?id=${encodeURIComponent(this.data.station?.id || "")}`)) return;
      wx.showToast({ title: error instanceof Error ? error.message : "读取号源失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
  dateChange(event) {
    this.setData({ date: event.detail.value });
    void this.loadSlots();
  },
  async adjust(event) {
    if (this.data.savingId) return;
    const id = event.currentTarget.dataset.id as string;
    const delta = Number(event.currentTarget.dataset.delta);
    const slot = this.data.slots.find((item) => item.id === id);
    if (!slot) return;
    const capacity = Math.max(slot.capacity - slot.remaining, slot.capacity + delta);
    this.setData({ savingId: id });
    try {
      const updated = slotView(await api.updateCapacity(id, capacity));
      this.setData({ slots: this.data.slots.map((item) => item.id === id ? updated : item) });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "更新失败", icon: "none" });
    } finally {
      this.setData({ savingId: "" });
    }
  },
});
