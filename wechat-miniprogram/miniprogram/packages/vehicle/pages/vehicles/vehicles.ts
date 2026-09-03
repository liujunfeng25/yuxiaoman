import { api } from "../../../../services/api";
import type { Vehicle } from "../../../../types";

type VehicleView = Vehicle & {
  powertrainLabel: string;
  validityLabel: string;
  brandModelLabel: string;
  vehicleImage: string;
  washCategoryLabel: string;
};
type Data = { vehicles: VehicleView[]; loading: boolean };

const powertrainLabels: Record<string, string> = {
  gasoline: "汽油",
  diesel: "柴油",
  hybrid: "油电混合（非插电）",
  pure_electric: "纯电",
  phev: "插电混动",
  erev: "增程",
  other: "其他能源",
};

function validitySourceLabel(source: string): string {
  if (source === "traffic_12123") return "交管12123";
  if (source === "electronic_driving_license") return "电子行驶证";
  if (source === "paper_driving_license") return "纸质行驶证";
  return "所选凭证";
}

function powertrainLabel(vehicle: Vehicle): string {
  const label = powertrainLabels[vehicle.powertrainType || ""] || "动力待补充";
  const source = vehicle.facts?.powertrainSource;
  if (source === "conflict") return "动力信息冲突 · 待核验";
  if (vehicle.powertrainType === "unknown") {
    return vehicle.energyCategory === "non_pure_electric" ? "非纯电新能源（具体动力待确认）" : "动力待确认";
  }
  if (source === "unknown") return `${label}（待确认）`;
  if (source === "plate_inferred" && vehicle.energyCategory === "non_pure_electric") return "非纯电新能源（具体动力待确认）";
  if (source === "plate_inferred") return `${label}（车牌识别）`;
  return label;
}

function validityLabel(vehicle: Vehicle): string {
  const validity = vehicle.inspectionValidity;
  if (!validity || validity.mode !== "confirmed") return "检验有效期尚未由用户核对 · 可进入年检查询测算";
  const confirmedOn = validity.confirmedAt ? validity.confirmedAt.slice(0, 10) : "";
  const confirmation = confirmedOn
    ? `用户于 ${confirmedOn} 根据${validitySourceLabel(validity.source)}确认`
    : `用户根据${validitySourceLabel(validity.source)}确认`;
  return `${confirmation} · 有效期至 ${validity.validThroughMonth}`;
}

Page<Data>({
  data: { vehicles: [], loading: true },
  onShow() { void this.load(); },
  async load() {
    this.setData({ loading: true });
    try {
      const vehicles = await api.vehicles();
      this.setData({ vehicles: vehicles.map((item) => ({
        ...item,
        powertrainLabel: powertrainLabel(item),
        validityLabel: validityLabel(item),
        brandModelLabel: item.brand && item.model ? `${item.brand.name} ${item.model.name}` : "品牌车型待设置",
        vehicleImage: item.visual?.imageUrl || "/assets/brand/hero-car-generic.png",
        washCategoryLabel: item.washVehicleCategory === "mpv" ? "MPV" : item.washVehicleCategory === "suv" || item.washVehicleCategory === "suv_mpv" ? "SUV" : "小轿车",
      })) });
    }
    catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "读取车辆失败", icon: "none" }); }
    finally { this.setData({ loading: false }); }
  },
  addVehicle() { wx.navigateTo({ url: "/packages/vehicle/pages/vehicle-form/vehicle-form" }); },
  edit(event) { wx.navigateTo({ url: `/packages/vehicle/pages/vehicle-form/vehicle-form?id=${event.currentTarget.dataset.id as string}` }); },
  async setDefault(event) {
    const id = event.currentTarget.dataset.id as string;
    try {
      await api.updateVehicle(id, { isDefault: true });
      wx.showToast({ title: "已设为当前车辆", icon: "success" });
      await this.load();
      setTimeout(() => wx.navigateBack(), 350);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "设置失败", icon: "none" });
    }
  },
  vehicleImageError(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ [`vehicles[${index}].vehicleImage`]: "/assets/brand/hero-car-generic.png" });
  },
  deleteVehicle(event) {
    const id = event.currentTarget.dataset.id as string;
    wx.showModal({ title: "删除车辆", content: "没有进行中预约的车辆才可以删除。", confirmColor: "#d84646", success: async ({ confirm }) => {
      if (!confirm) return;
      try { await api.deleteVehicle(id); wx.showToast({ title: "已删除", icon: "success" }); void this.load(); }
      catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "删除失败", icon: "none" }); }
    } });
  },
});
