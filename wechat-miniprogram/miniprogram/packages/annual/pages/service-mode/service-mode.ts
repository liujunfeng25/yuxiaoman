import { clearBookingDraft, saveBookingDraft } from "../../../../services/storage";
import type { ServiceMode } from "../../../../types";
type Data = { mode: ServiceMode; vehicleId: string };
Page<Data>({
  data: { mode: "self_drive", vehicleId: "" },
  onLoad(query) { this.setData({ vehicleId: query.vehicleId || "" }); },
  choose(event) { this.setData({ mode: event.currentTarget.dataset.mode as ServiceMode }); },
  next() { clearBookingDraft(); saveBookingDraft({ serviceMode: this.data.mode, vehicleId: this.data.vehicleId || undefined }); wx.navigateTo({ url: `/packages/annual/pages/stations/stations?mode=${this.data.mode}` }); },
});
