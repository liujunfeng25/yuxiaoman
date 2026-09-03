import { api } from "../../../../services/api";
import type {
  InspectionPowertrainType,
  InspectionValiditySource,
  ServiceMode,
  VehicleCatalogBrand,
  VehicleCatalogModel,
  VehicleInput,
  WashVehicleCategory,
} from "../../../../types";

type PlateMode = "blue" | "green_small" | "green_large";
type VehiclePowertrain = InspectionPowertrainType;
type SourceOption = { value: InspectionValiditySource; label: string };
type Data = {
  id: string;
  mode: PlateMode;
  cells: string[];
  selected: number;
  vehicleType: string;
  washVehicleCategory: WashVehicleCategory;
  washVehicleCategoryLegacy: boolean;
  washVehicleCategoryTouched: boolean;
  seats: number;
  registrationDate: string;
  powertrainType: VehiclePowertrain;
  powertrainTouched: boolean;
  validityConfirmed: boolean;
  validThroughMonth: string;
  validitySourceIndex: number;
  validitySourceSelected: boolean;
  validitySources: SourceOption[];
  legacyUnverifiedDate: string;
  originalValidityKey: string;
  nextAfterSave: "" | "inspection_booking";
  requestedServiceMode: ServiceMode | null;
  provinceOpen: boolean;
  plateInputOpen: boolean;
  plateComplete: boolean;
  saving: boolean;
  provinces: string[];
  numberKeys: string[];
  letterKeys: string[];
  catalogLoading: boolean;
  catalogBrands: VehicleCatalogBrand[];
  activeBrandId: string;
  activeModels: VehicleCatalogModel[];
  selectedBrandId: string;
  selectedBrandName: string;
  selectedModelId: string;
  selectedModelName: string;
  selectedModelImage: string;
  catalogOpen: boolean;
};
const provinces = ["津", "京", "冀", "晋", "蒙", "辽", "吉", "黑", "沪", "苏", "浙", "皖", "闽", "赣", "鲁", "豫", "鄂", "湘", "粤", "桂", "琼", "渝", "川", "贵", "云", "藏", "陕", "甘", "青", "宁", "新"];
const numberKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const letterKeys = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function plateLength(mode: PlateMode) { return mode === "blue" ? 7 : 8; }
function initialSelectedIndex() { return 2; }
function detectPlateMode(normalized: string): PlateMode {
  if (normalized.length !== 8) return "blue";
  const serial = normalized.slice(2);
  return /^\d{5}[DF]$/.test(serial) ? "green_large" : "green_small";
}
function isSerialKeyAllowed(mode: PlateMode, index: number, key: string): boolean {
  if (key === "I" || key === "O") return false;
  if (index === 1) return /^[A-HJ-NP-Z]$/.test(key);
  if (mode === "green_large") {
    if (index >= 2 && index <= 6) return /^\d$/.test(key);
    if (index === 7) return key === "D" || key === "F";
    return false;
  }
  return /^[A-HJ-NP-Z0-9]$/.test(key);
}
function isPlateComplete(cells: string[], mode: PlateMode): boolean {
  return cells.length === plateLength(mode) && cells.every(Boolean);
}
const validitySources: SourceOption[] = [
  { value: "traffic_12123", label: "交管12123" },
  { value: "electronic_driving_license", label: "电子行驶证" },
  { value: "paper_driving_license", label: "纸质行驶证" },
];

function makeCells(mode: PlateMode, current: string[] = []): string[] {
  const next = Array.from({ length: plateLength(mode) }, (_, index) => current[index] || "");
  if (!next[0]) next[0] = "津";
  if (current.length === 0 && !next[1]) next[1] = "A";
  return next;
}

function isPowertrain(value: string | undefined): value is VehiclePowertrain {
  return ["gasoline", "diesel", "hybrid", "pure_electric", "phev", "erev", "other", "unknown"].includes(value || "");
}

function resolveLoadedPowertrain(vehicle: {
  powertrainType?: string | null;
  facts?: { powertrainSource?: string | null } | null;
}, mode: PlateMode): VehiclePowertrain {
  const candidate = vehicle.powertrainType || undefined;
  const stored: VehiclePowertrain = isPowertrain(candidate) ? candidate : "unknown";
  const source = vehicle.facts?.powertrainSource;
  if (source === "unknown" || source === "conflict" || source === "plate_inferred") {
    return mode === "blue" ? "unknown" : (stored === "pure_electric" || stored === "phev" || stored === "erev" ? stored : "unknown");
  }
  if (mode !== "blue" && (stored === "gasoline" || stored === "diesel" || stored === "hybrid" || stored === "other")) {
    return "unknown";
  }
  return stored;
}

function isValiditySource(value: string | undefined): value is InspectionValiditySource {
  return validitySources.some((item) => item.value === value);
}

function validityKey(confirmed: boolean, month: string, source: InspectionValiditySource): string {
  return confirmed ? `confirmed|${month}|${source}` : "unconfirmed";
}

Page<Data>({
  data: {
    id: "",
    mode: "blue",
    cells: makeCells("blue"),
    selected: 2,
    vehicleType: "小型轿车",
    washVehicleCategory: "sedan",
    washVehicleCategoryLegacy: false,
    washVehicleCategoryTouched: false,
    seats: 5,
    registrationDate: "2020-01-01",
    powertrainType: "unknown",
    powertrainTouched: false,
    validityConfirmed: false,
    validThroughMonth: "",
    validitySourceIndex: 0,
    validitySourceSelected: false,
    validitySources,
    legacyUnverifiedDate: "",
    originalValidityKey: "unconfirmed",
    nextAfterSave: "",
    requestedServiceMode: null,
    provinceOpen: false,
    plateInputOpen: false,
    plateComplete: false,
    saving: false,
    provinces,
    numberKeys,
    letterKeys,
    catalogLoading: true,
    catalogBrands: [],
    activeBrandId: "",
    activeModels: [],
    selectedBrandId: "",
    selectedBrandName: "",
    selectedModelId: "",
    selectedModelName: "",
    selectedModelImage: "/assets/brand/hero-car-generic.png",
    catalogOpen: false,
  },
  async onLoad(query) {
    let catalogBrands: VehicleCatalogBrand[] = [];
    try {
      const catalog = await api.vehicleCatalog();
      catalogBrands = catalog.brands;
      this.setData({
        catalogLoading: false,
        catalogBrands,
        activeBrandId: catalogBrands[0]?.id || "",
        activeModels: catalogBrands[0]?.models || [],
      });
    } catch {
      this.setData({ catalogLoading: false });
    }
    if (!query.id) {
      const requestedServiceMode: ServiceMode | null = query.serviceMode === "valet"
        ? "valet"
        : query.serviceMode === "self_drive"
          ? "self_drive"
          : null;
      const registrationDate = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.registrationMonth || "") ? `${query.registrationMonth}-01` : this.data.registrationDate;
      const seats = /^\d+$/.test(query.seats || "") ? Math.max(2, Math.min(20, Number(query.seats))) : this.data.seats;
      const powertrainType = isPowertrain(query.powertrainType) ? query.powertrainType : "unknown";
      const mode: PlateMode = powertrainType === "pure_electric" || powertrainType === "phev" || powertrainType === "erev"
        ? "green_small"
        : "blue";
      const hasValiditySource = isValiditySource(query.validitySource);
      const validThroughMonth = hasValiditySource && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.validThroughMonth || "") ? query.validThroughMonth : "";
      const validitySourceIndex = hasValiditySource
        ? Math.max(0, validitySources.findIndex((item) => item.value === query.validitySource))
        : 0;
      const cells = makeCells(mode);
      this.setData({
        mode,
        cells,
        selected: initialSelectedIndex(),
        registrationDate,
        seats,
        vehicleType: mode === "blue" ? (seats === 7 ? "7 座乘用车" : "小型轿车") : "新能源小型汽车",
        washVehicleCategory: "sedan",
        washVehicleCategoryLegacy: false,
        washVehicleCategoryTouched: false,
        powertrainType,
        powertrainTouched: false,
        validityConfirmed: Boolean(validThroughMonth) && hasValiditySource,
        validThroughMonth,
        validitySourceIndex,
        validitySourceSelected: Boolean(validThroughMonth) && hasValiditySource,
        originalValidityKey: "unconfirmed",
        nextAfterSave: query.next === "inspection_booking" || query.returnTo === "inspection_booking" ? "inspection_booking" : "",
        requestedServiceMode,
        plateComplete: isPlateComplete(cells, mode),
      });
      return;
    }
    try {
      const vehicle = (await api.vehicles()).find((item) => item.id === query.id);
      if (!vehicle) throw new Error("未找到车辆");
      const normalized = vehicle.plateNumber.replace(/[·\s]/g, "");
      const mode: PlateMode = detectPlateMode(normalized);
      const cells = makeCells(mode, normalized.split(""));
      const validity = vehicle.inspectionValidity;
      const sourceIndex = validity?.mode === "confirmed"
        ? Math.max(0, validitySources.findIndex((item) => item.value === validity.source))
        : 0;
      const activeBrand = catalogBrands.find((item) => item.id === vehicle.brand?.id) || catalogBrands[0];
      this.setData({
        id: vehicle.id,
        mode,
        cells,
        vehicleType: vehicle.vehicleType,
        washVehicleCategory: vehicle.washVehicleCategory === "mpv" ? "mpv" : vehicle.washVehicleCategory === "suv" || vehicle.washVehicleCategory === "suv_mpv" ? "suv" : "sedan",
        washVehicleCategoryLegacy: Boolean(vehicle.washVehicleCategoryLegacy || vehicle.washVehicleCategory === "suv_mpv"),
        washVehicleCategoryTouched: true,
        seats: vehicle.seats,
        registrationDate: vehicle.registrationDate,
        powertrainType: resolveLoadedPowertrain(vehicle, mode),
        powertrainTouched: false,
        validityConfirmed: validity?.mode === "confirmed",
        validThroughMonth: validity?.mode === "confirmed" ? validity.validThroughMonth : "",
        validitySourceIndex: sourceIndex,
        validitySourceSelected: validity?.mode === "confirmed",
        legacyUnverifiedDate: vehicle.inspectionDueDateSource === "legacy_unverified" ? vehicle.inspectionDueDate : "",
        originalValidityKey: validity?.mode === "confirmed"
          ? validityKey(true, validity.validThroughMonth, validity.source)
          : "unconfirmed",
        plateComplete: isPlateComplete(cells, mode),
        activeBrandId: activeBrand?.id || "",
        activeModels: activeBrand?.models || [],
        selectedBrandId: vehicle.brand?.id || "",
        selectedBrandName: vehicle.brand?.name || "",
        selectedModelId: vehicle.model?.id || "",
        selectedModelName: vehicle.model?.name || "",
      selectedModelImage: vehicle.visual?.imageUrl || "/assets/brand/hero-car-generic.png",
      });
      wx.setNavigationBarTitle({ title: "编辑车辆" });
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "读取车辆失败", icon: "none" }); }
  },
  selectCell(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ selected: index, provinceOpen: index === 0, plateInputOpen: true });
  },
  chooseMode(event) {
    const mode = event.currentTarget.dataset.mode as PlateMode;
    if (mode === this.data.mode) return;
    const preservedPrefix = [this.data.cells[0] || "津", this.data.cells[1] || "A"];
    const switchingBetweenGreen = this.data.mode !== "blue" && mode !== "blue";
    const powertrainType: VehiclePowertrain = mode === "blue"
      ? "unknown"
      : switchingBetweenGreen && ["pure_electric", "phev", "erev", "unknown"].includes(this.data.powertrainType)
        ? this.data.powertrainType
        : "unknown";
    const cells = makeCells(mode, preservedPrefix);
    const vehicleType = mode === "blue" ? "小型轿车" : "新能源小型汽车";
    this.setData({
      mode,
      cells,
      selected: initialSelectedIndex(),
      provinceOpen: false,
      vehicleType,
      ...(!this.data.washVehicleCategoryTouched ? { washVehicleCategory: "sedan" as WashVehicleCategory } : {}),
      powertrainType,
      powertrainTouched: true,
      plateComplete: isPlateComplete(cells, mode),
    });
  },
  choosePowertrain(event) {
    const powertrainType = event.currentTarget.dataset.value as VehiclePowertrain;
    this.setData({ powertrainType, powertrainTouched: true });
  },
  chooseProvince(event) {
    const cells = [...this.data.cells]; cells[0] = event.currentTarget.dataset.key as string;
    this.setData({ cells, selected: 1, provinceOpen: false, plateInputOpen: true, plateComplete: isPlateComplete(cells, this.data.mode) });
  },
  key(event) {
    const key = event.currentTarget.dataset.key as string;
    const cells = [...this.data.cells];
    let selected = this.data.selected;
    if (key === "delete") {
      if (cells[selected]) {
        cells[selected] = "";
      } else if (selected > 0) {
        selected -= 1;
        cells[selected] = "";
      }
      this.setData({
        cells,
        selected,
        provinceOpen: selected === 0,
        plateComplete: isPlateComplete(cells, this.data.mode),
      });
      return;
    }
    if (selected === 0) { cells[0] = key; this.setData({ cells, selected: 1, provinceOpen: false, plateComplete: isPlateComplete(cells, this.data.mode) }); return; }
    if (selected >= cells.length) return;
    if (!isSerialKeyAllowed(this.data.mode, selected, key)) return;
    cells[selected] = key;
    selected = Math.min(selected + 1, cells.length - 1);
    this.setData({ cells, selected, plateComplete: isPlateComplete(cells, this.data.mode) });
  },
  clearPlateSerial() {
    const province = this.data.cells[0] || "津";
    const cells = makeCells(this.data.mode, [province]);
    this.setData({ cells, selected: 1, provinceOpen: false, plateComplete: false });
  },
  closePlateInput() { this.setData({ plateInputOpen: false, provinceOpen: false }); },
  openCatalog() {
    this.setData({ plateInputOpen: false, provinceOpen: false, catalogOpen: true });
  },
  closeCatalog() { this.setData({ catalogOpen: false }); },
  noop() { /* Stops the sheet tap from reaching the dismiss mask. */ },
  chooseCatalogBrand(event) {
    const activeBrandId = String(event.currentTarget.dataset.id || "");
    const brand = this.data.catalogBrands.find((item) => item.id === activeBrandId);
    if (!brand) return;
    this.setData({ activeBrandId, activeModels: brand.models });
  },
  chooseCatalogModel(event) {
    const selectedModelId = String(event.currentTarget.dataset.id || "");
    const brand = this.data.catalogBrands.find((item) => item.id === this.data.activeBrandId);
    const model = brand?.models.find((item) => item.id === selectedModelId);
    if (!brand || !model) return;
    this.setData({
      selectedBrandId: brand.id,
      selectedBrandName: brand.name,
      selectedModelId: model.id,
      selectedModelName: model.name,
      selectedModelImage: model.imageUrl,
      catalogOpen: false,
    });
  },
  clearCatalogSelection() {
    this.setData({
      selectedBrandId: "",
      selectedBrandName: "",
      selectedModelId: "",
      selectedModelName: "",
      selectedModelImage: "/assets/brand/hero-car-generic.png",
      catalogOpen: false,
    });
  },
  vehicleImageError() {
    if (this.data.selectedModelImage !== "/assets/brand/hero-car-generic.png") {
      this.setData({ selectedModelImage: "/assets/brand/hero-car-generic.png" });
    }
  },
  typeChange(event) {
    const vehicleType = event.currentTarget.dataset.type as string;
    const defaultCategory: WashVehicleCategory = /MPV|商务/i.test(vehicleType) ? "mpv" : /SUV|越野/i.test(vehicleType) ? "suv" : "sedan";
    this.setData({
      vehicleType,
      seats: Number(event.currentTarget.dataset.seats),
      ...(!this.data.washVehicleCategoryTouched ? { washVehicleCategory: defaultCategory } : {}),
    });
  },
  chooseWashCategory(event) {
    const washVehicleCategory = event.currentTarget.dataset.value as WashVehicleCategory;
    if (!["sedan", "suv", "mpv"].includes(washVehicleCategory)) return;
    this.setData({ washVehicleCategory, washVehicleCategoryTouched: true });
  },
  dateChange(event) { this.setData({ registrationDate: String(event.detail.value) }); },
  setValidityMode(event) {
    const validityConfirmed = event.currentTarget.dataset.value === "confirmed";
    this.setData(validityConfirmed
      ? { validityConfirmed }
      : {
          validityConfirmed,
          validThroughMonth: "",
          validitySourceIndex: 0,
          validitySourceSelected: false,
        });
  },
  validityMonthChange(event) { this.setData({ validThroughMonth: String(event.detail.value) }); },
  validitySourceChange(event) {
    if (!this.data.validThroughMonth) return;
    this.setData({ validitySourceIndex: Number(event.detail.value), validitySourceSelected: true });
  },
  async submit() {
    const plateNumber = this.data.cells.join("");
    if (this.data.cells.some((item) => !item) || plateNumber.length !== plateLength(this.data.mode)) { wx.showToast({ title: "请补全车牌号", icon: "none" }); return; }
    if (this.data.validityConfirmed && !/^\d{4}-(0[1-9]|1[0-2])$/.test(this.data.validThroughMonth)) { wx.showToast({ title: "请选择检验有效期月份", icon: "none" }); return; }
    if (this.data.validityConfirmed && !this.data.validitySourceSelected) { wx.showToast({ title: "请选择看到日期的位置", icon: "none" }); return; }
    this.setData({ saving: true });
    const selectedValiditySource = this.data.validitySources[this.data.validitySourceIndex].value;
    const nextValidityKey = validityKey(this.data.validityConfirmed, this.data.validThroughMonth, selectedValiditySource);
    const data: Partial<VehicleInput> = {
      plateNumber,
      vehicleType: this.data.vehicleType,
      seats: this.data.seats,
      registrationDate: this.data.registrationDate,
      brandId: this.data.selectedBrandId || null,
      modelId: this.data.selectedModelId || null,
      washVehicleCategory: this.data.washVehicleCategory,
    };
    if (!this.data.id) {
      data.usageNature = "非营运";
      data.vehicleClassCode = "passenger_car";
      data.isVan = false;
      data.isDefault = true;
    }
    if (!this.data.id || this.data.powertrainTouched) data.powertrainType = this.data.powertrainType;
    if (!this.data.id || nextValidityKey !== this.data.originalValidityKey) {
      data.inspectionValidity = this.data.validityConfirmed
        ? {
            mode: "confirmed",
            validThroughMonth: this.data.validThroughMonth,
            source: selectedValiditySource,
          }
        : { mode: "unconfirmed" };
    }
    try {
      const vehicle = this.data.id
        ? await api.updateVehicle(this.data.id, data)
        : await api.createVehicle(data as VehicleInput);
      wx.showToast({ title: "车辆已保存", icon: "success" });
      if (!this.data.id && this.data.nextAfterSave === "inspection_booking") {
        const status = await api.inspection(vehicle.id).catch(() => null);
        if (status?.canBook) {
          const vehicleId = encodeURIComponent(vehicle.id);
          if (this.data.requestedServiceMode) {
            wx.redirectTo({ url: `/packages/annual/pages/stations/stations?serviceMode=${this.data.requestedServiceMode}&vehicleId=${vehicleId}&returnTo=inspection_booking` });
          } else {
            wx.redirectTo({ url: `/packages/annual/pages/service-mode/service-mode?vehicleId=${vehicleId}` });
          }
        } else {
          wx.showToast({ title: "日期或办理状态已变化，请重新核验", icon: "none" });
          const modeQuery = this.data.requestedServiceMode ? `&serviceMode=${this.data.requestedServiceMode}&returnTo=inspection_booking` : "";
          wx.redirectTo({ url: `/packages/annual/pages/eligibility/eligibility?vehicleId=${encodeURIComponent(vehicle.id)}${modeQuery}` });
        }
      } else {
        wx.navigateBack();
      }
    }
    catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" }); }
    finally { this.setData({ saving: false }); }
  },
});
