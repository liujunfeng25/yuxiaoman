import { PLATE_CATEGORIES, plateCategory, legacyPlateCategory, type PlateCategoryCode, type PlateStyle } from "../../../../utils/plate-categories";
import { formatPlateNumber, isPlateSlotsComplete, normalizePlateChars, plateSlotCount } from "../../../../utils/plate-keyboard-layout";
import { api } from "../../../../services/api";
import { searchVehicleCatalog, type CatalogBrandOption } from "../../utils/catalog-search";
import type {
  InspectionPowertrainType,
  InspectionValiditySource,
  ServiceMode,
  VehicleCatalogBrand,
  VehicleCatalogModel,
  VehicleInput,
  WashVehicleCategory,
} from "../../../../types";

type PlateMode = PlateStyle;
type VehiclePowertrain = InspectionPowertrainType;
type SourceOption = { value: InspectionValiditySource; label: string };
type ExteriorColorOption = { value: string; label: string; hex: string };
type CatalogModelOption = VehicleCatalogModel & { imageLoadFailed?: boolean };
type Data = {
  id: string;
  mode: PlateMode;
  plateCategories: typeof PLATE_CATEGORIES;
  plateCategoryIndex: number;
  plateCategory: PlateCategoryCode;
  plateCategoryConfirmed: boolean;
  usageNature: string;
  plateNumber: string;
  slotCount: 7 | 8;
  vehicleType: string;
  washVehicleCategory: WashVehicleCategory;
  washVehicleCategoryLegacy: boolean;
  washVehicleCategoryTouched: boolean;
  seats: number;
  passengerColorEnabled: boolean;
  exteriorColors: ExteriorColorOption[];
  exteriorColor: string;
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
  plateComplete: boolean;
  saving: boolean;
  catalogLoading: boolean;
  catalogError: boolean;
  catalogBrands: VehicleCatalogBrand[];
  catalogBrandOptions: CatalogBrandOption[];
  catalogQuery: string;
  catalogMatchCount: number;
  catalogScrollRevision: number;
  activeBrandId: string;
  activeBrandName: string;
  activeModels: CatalogModelOption[];
  selectedBrandId: string;
  selectedBrandName: string;
  selectedModelId: string;
  selectedModelName: string;
  selectedModelImage: string;
  catalogOpen: boolean;
};
const editablePlatePattern = /^[\p{L}\p{N}\s·•・.\-]+$/u;

function isPlateInputSafe(value: string): boolean {
  const prepared = value.normalize("NFKC").trim();
  return Boolean(prepared)
    && prepared.length <= 32
    && editablePlatePattern.test(prepared)
    && Boolean(prepared.replace(/[\s·•・.\-]/gu, ""));
}
const validitySources: SourceOption[] = [
  { value: "traffic_12123", label: "交管12123" },
  { value: "electronic_driving_license", label: "电子行驶证" },
  { value: "paper_driving_license", label: "纸质行驶证" },
];
const exteriorColors: ExteriorColorOption[] = [
  { value: "白色", label: "白色", hex: "#f7f8fa" },
  { value: "黑色", label: "黑色", hex: "#1d232b" },
  { value: "银色", label: "银色", hex: "#b9c1ca" },
  { value: "灰色", label: "灰色", hex: "#707780" },
  { value: "红色", label: "红色", hex: "#c83d43" },
  { value: "蓝色", label: "蓝色", hex: "#3478c9" },
  { value: "绿色", label: "绿色", hex: "#477b61" },
  { value: "棕色", label: "棕色", hex: "#775341" },
  { value: "粉色", label: "粉色", hex: "#dc9eae" },
  { value: "金色", label: "金色", hex: "#c8a35e" },
  { value: "米色", label: "米色", hex: "#d8c8a5" },
  { value: "黄色", label: "黄色", hex: "#e8bd3e" },
  { value: "橙色", label: "橙色", hex: "#df7435" },
  { value: "紫色", label: "紫色", hex: "#765d91" },
  { value: "双色/其他", label: "双色/其他", hex: "linear-gradient(135deg,#eff3f7 0 50%,#48596b 50%)" },
];

function isPowertrain(value: string | undefined): value is VehiclePowertrain {
  return ["gasoline", "diesel", "hybrid", "pure_electric", "phev", "erev", "other", "unknown"].includes(value || "");
}

function resolveLoadedPowertrain(vehicle: {
  powertrainType?: string | null;
  facts?: { powertrainSource?: string | null } | null;
}, mode: PlateMode): VehiclePowertrain {
  const candidate = vehicle.powertrainType || undefined;
  const stored: VehiclePowertrain = isPowertrain(candidate) ? candidate : "unknown";
  if (vehicle.facts?.powertrainSource === "unknown" || vehicle.facts?.powertrainSource === "plate_inferred") return "unknown";
  return stored;
}

function isValiditySource(value: string | undefined): value is InspectionValiditySource {
  return validitySources.some((item) => item.value === value);
}

function validityKey(confirmed: boolean, month: string, source: InspectionValiditySource): string {
  return confirmed ? `confirmed|${month}|${source}` : "unconfirmed";
}

function vehicleClassCodeForCategory(categoryCode: PlateCategoryCode): string {
  return plateCategory(categoryCode)?.vehicleClassCode || "passenger_car";
}

function searchCatalogForCategory(
  brands: VehicleCatalogBrand[],
  query: string,
  preferredBrandId: string,
  categoryCode: PlateCategoryCode,
) {
  return searchVehicleCatalog(brands, query, preferredBrandId, vehicleClassCodeForCategory(categoryCode));
}

Page<Data>({
  data: {
    id: "",
    mode: "blue",
    plateCategories: PLATE_CATEGORIES,
    plateCategoryIndex: 0,
    plateCategory: "blue_small_passenger",
    plateCategoryConfirmed: true,
    usageNature: "非营运",
    plateNumber: "",
    slotCount: 7,
    vehicleType: "小型轿车",
    washVehicleCategory: "sedan",
    washVehicleCategoryLegacy: false,
    washVehicleCategoryTouched: false,
    seats: 5,
    passengerColorEnabled: true,
    exteriorColors,
    exteriorColor: "",
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
    plateComplete: false,
    saving: false,
    catalogLoading: true,
    catalogError: false,
    catalogBrands: [],
    catalogBrandOptions: [],
    catalogQuery: "",
    catalogMatchCount: 0,
    catalogScrollRevision: 0,
    activeBrandId: "",
    activeBrandName: "",
    activeModels: [],
    selectedBrandId: "",
    selectedBrandName: "",
    selectedModelId: "",
    selectedModelName: "",
    selectedModelImage: "/assets/brand/hero-car-generic.png",
    catalogOpen: false,
  },
  async loadCatalog() {
    this.setData({ catalogLoading: true, catalogError: false });
    try {
      const catalog = await api.vehicleCatalog();
      if (!catalog.brands.length) throw new Error("车型库为空");
      this.setData({
        catalogLoading: false,
        catalogBrands: catalog.brands,
        ...searchCatalogForCategory(catalog.brands, this.data.catalogQuery, this.data.selectedBrandId || this.data.activeBrandId, this.data.plateCategory),
      });
    } catch {
      this.setData({ catalogLoading: false, catalogError: true });
    }
  },
  async onLoad(query) {
    await this.loadCatalog();
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
      this.setData({
        mode,
        plateCategory: mode === "blue" ? "blue_small_passenger" : "new_energy_small_passenger",
        plateCategoryIndex: mode === "blue" ? 0 : 1,
        plateNumber: "",
        slotCount: plateSlotCount(mode),
        registrationDate,
        seats,
        passengerColorEnabled: true,
        exteriorColor: "",
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
        plateComplete: false,
      });
      return;
    }
    try {
      const vehicle = (await api.vehicles()).find((item) => item.id === query.id);
      if (!vehicle) throw new Error("未找到车辆");
      const resolvedCategory = plateCategory(vehicle.plateCategory) ?? legacyPlateCategory(vehicle.vehicleType, vehicle.plateNumber, vehicle.vehicleClassCode);
      const category = resolvedCategory ?? PLATE_CATEGORIES[0];
      const mode: PlateMode = category.plateKind;
      const slotCount = plateSlotCount(mode);
      const formattedPlate = formatPlateNumber(normalizePlateChars(vehicle.plateNumber).slice(0, slotCount));
      const validity = vehicle.inspectionValidity;
      const sourceIndex = validity?.mode === "confirmed"
        ? Math.max(0, validitySources.findIndex((item) => item.value === validity.source))
        : 0;
      this.setData({
        id: vehicle.id,
        mode,
        plateCategory: category.code,
        plateCategoryConfirmed: Boolean(resolvedCategory),
        plateCategoryIndex: PLATE_CATEGORIES.indexOf(category),
        usageNature: vehicle.usageNature,
        plateNumber: formattedPlate,
        slotCount,
        vehicleType: vehicle.vehicleType,
        washVehicleCategory: vehicle.washVehicleCategory === "mpv" ? "mpv" : vehicle.washVehicleCategory === "suv" || vehicle.washVehicleCategory === "suv_mpv" ? "suv" : "sedan",
        washVehicleCategoryLegacy: Boolean(vehicle.washVehicleCategoryLegacy || vehicle.washVehicleCategory === "suv_mpv"),
        washVehicleCategoryTouched: true,
        seats: vehicle.seats,
        passengerColorEnabled: category.vehicleClassCode === "passenger_car" || category.vehicleClassCode === "large_bus",
        exteriorColor: vehicle.exteriorColor || "",
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
        plateComplete: isPlateSlotsComplete(formattedPlate, slotCount) && isPlateInputSafe(formattedPlate),
        ...searchCatalogForCategory(this.data.catalogBrands, this.data.catalogQuery, vehicle.brand?.id || "", category.code),
        selectedBrandId: vehicle.brand?.id || "",
        selectedBrandName: vehicle.brand?.name || "",
        selectedModelId: vehicle.model?.id || "",
        selectedModelName: vehicle.model?.name || "",
        selectedModelImage: vehicle.model?.id ? vehicle.visual?.imageUrl || "" : "/assets/brand/hero-car-generic.png",
      });
      wx.setNavigationBarTitle({ title: "编辑车辆" });
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "读取车辆失败", icon: "none" }); }
  },
  categoryChange(event) {
    const plateCategoryIndex = Number(event.detail.value);
    const category = PLATE_CATEGORIES[plateCategoryIndex];
    if (!category) return;
    const mode = category.plateKind;
    const sameClass = plateCategory(this.data.plateCategory)?.vehicleClassCode === category.vehicleClassCode;
    const selectedModel = this.data.catalogBrands.flatMap((brand) => brand.models)
      .find((model) => model.id === this.data.selectedModelId);
    const selectionStillApplies = !this.data.selectedModelId
      || Boolean(selectedModel && (selectedModel.vehicleClassCodes || ["passenger_car"]).includes(category.vehicleClassCode));
    this.setData({ plateCategoryIndex, plateCategory: category.code, plateCategoryConfirmed: true, mode,
      slotCount: plateSlotCount(mode),
      plateNumber: "",
      plateComplete: false,
      vehicleType: sameClass ? this.data.vehicleType : category.vehicleType,
      seats: sameClass ? this.data.seats : category.defaultSeats,
      passengerColorEnabled: category.vehicleClassCode === "passenger_car" || category.vehicleClassCode === "large_bus",
      exteriorColor: category.vehicleClassCode === "passenger_car" || category.vehicleClassCode === "large_bus" ? this.data.exteriorColor : "",
      ...searchCatalogForCategory(this.data.catalogBrands, "", selectionStillApplies ? this.data.selectedBrandId : "", category.code),
      catalogQuery: "",
      ...(!selectionStillApplies ? {
        selectedBrandId: "", selectedBrandName: "", selectedModelId: "", selectedModelName: "",
        selectedModelImage: "/assets/brand/hero-car-generic.png",
      } : {}),
    });
  },
  onPlateKeyboardChange(event) {
    const plateNumber = String(event.detail.value || "");
    const complete = Boolean(event.detail.complete) || isPlateSlotsComplete(plateNumber, this.data.slotCount);
    this.setData({ plateNumber, plateComplete: complete && isPlateInputSafe(plateNumber) });
  },
  plateNumberInput(event) {
    this.onPlateKeyboardChange({
      detail: {
        value: String(event.detail.value || ""),
        complete: isPlateSlotsComplete(String(event.detail.value || ""), this.data.slotCount),
      },
    });
  },
  vehicleTypeInput(event) { this.setData({ vehicleType: String(event.detail.value) }); },
  usageNatureInput(event) { this.setData({ usageNature: String(event.detail.value) }); },
  seatsInput(event) { this.setData({ seats: event.detail.value === "" ? -1 : Number(event.detail.value) }); },
  chooseExteriorColor(event) { this.setData({ exteriorColor: String(event.currentTarget.dataset.value || "") }); },
  exteriorColorInput(event) { this.setData({ exteriorColor: String(event.detail.value || "") }); },
  clearExteriorColor() { this.setData({ exteriorColor: "" }); },
  choosePowertrain(event) {
    const powertrainType = event.currentTarget.dataset.value as VehiclePowertrain;
    if (!isPowertrain(powertrainType) || powertrainType === "unknown") return;
    this.setData({ powertrainType, powertrainTouched: true });
  },
  openCatalog() {
    wx.hideKeyboard();
    this.setData({
      catalogOpen: true, catalogQuery: "",
      catalogScrollRevision: this.data.catalogScrollRevision + 1,
      ...searchCatalogForCategory(this.data.catalogBrands, "", this.data.selectedBrandId || this.data.activeBrandId, this.data.plateCategory),
    });
  },
  closeCatalog() { wx.hideKeyboard(); this.setData({ catalogOpen: false }); },
  noop() { /* Stops the sheet tap from reaching the dismiss mask. */ },
  searchCatalog(event) {
    const catalogQuery = String(event.detail.value || "");
    this.setData({
      catalogQuery,
      catalogScrollRevision: this.data.catalogScrollRevision + 1,
      ...searchCatalogForCategory(this.data.catalogBrands, catalogQuery, this.data.activeBrandId, this.data.plateCategory),
    });
  },
  clearCatalogSearch() { this.searchCatalog({ detail: { value: "" } }); },
  chooseCatalogBrand(event) {
    const activeBrandId = String(event.currentTarget.dataset.id || "");
    if (!this.data.catalogBrandOptions.some((item) => item.id === activeBrandId)) return;
    wx.hideKeyboard();
    this.setData({
      catalogScrollRevision: this.data.catalogScrollRevision + 1,
      ...searchCatalogForCategory(this.data.catalogBrands, this.data.catalogQuery, activeBrandId, this.data.plateCategory),
    });
  },
  chooseCatalogModel(event) {
    const selectedModelId = String(event.currentTarget.dataset.id || "");
    const brand = this.data.catalogBrands.find((item) => item.id === this.data.activeBrandId);
    const model = this.data.activeModels.find((item) => item.id === selectedModelId);
    if (!brand || !model) return;
    wx.hideKeyboard();
    this.setData({
      selectedBrandId: brand.id,
      selectedBrandName: brand.name,
      selectedModelId: model.id,
      selectedModelName: model.name,
      selectedModelImage: model.imageUrl,
    });
  },
  clearCatalogSelection() {
    wx.hideKeyboard();
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
    if (this.data.selectedModelId) {
      this.setData({ selectedModelImage: "" });
    }
  },
  catalogModelImageError(event) {
    const failedModelId = String(event.currentTarget.dataset.id || "");
    if (!failedModelId) return;
    this.setData({
      activeModels: this.data.activeModels.map((model) => model.id === failedModelId
        ? { ...model, imageLoadFailed: true }
        : model),
      ...(this.data.selectedModelId === failedModelId ? { selectedModelImage: "" } : {}),
    });
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
    if (!this.data.plateCategoryConfirmed) { wx.showToast({ title: "请选择实际号牌类型", icon: "none" }); return; }
    const plateNumber = this.data.plateNumber.trim();
    if (!plateNumber) { wx.showToast({ title: "请输入车牌号", icon: "none" }); return; }
    if (!isPlateInputSafe(plateNumber)) { wx.showToast({ title: "请只填写实际号牌中的文字、字母、数字或分隔符", icon: "none" }); return; }
    if (!this.data.plateComplete || !isPlateSlotsComplete(plateNumber, this.data.slotCount)) {
      wx.showToast({ title: "请将车牌填完整", icon: "none" });
      return;
    }
    if (this.data.validityConfirmed && !/^\d{4}-(0[1-9]|1[0-2])$/.test(this.data.validThroughMonth)) { wx.showToast({ title: "请选择检验有效期月份", icon: "none" }); return; }
    if (this.data.validityConfirmed && !this.data.validitySourceSelected) { wx.showToast({ title: "请选择看到日期的位置", icon: "none" }); return; }
    if (!this.data.vehicleType.trim() || !this.data.usageNature.trim()) { wx.showToast({ title: "请填写车型和使用性质", icon: "none" }); return; }
    if (!Number.isInteger(this.data.seats) || this.data.seats < (this.data.plateCategory === "yellow_trailer" ? 0 : 1) || this.data.seats > 99) { wx.showToast({ title: "请填写实际核定座位数", icon: "none" }); return; }
    if (!isPowertrain(this.data.powertrainType) || this.data.powertrainType === "unknown") {
      wx.showToast({ title: "请选择动力类型", icon: "none" });
      return;
    }
    this.setData({ saving: true });
    const selectedValiditySource = this.data.validitySources[this.data.validitySourceIndex].value;
    const nextValidityKey = validityKey(this.data.validityConfirmed, this.data.validThroughMonth, selectedValiditySource);
    const data: Partial<VehicleInput> = {
      plateNumber,
      plateCategory: this.data.plateCategory,
      usageNature: this.data.usageNature,
      vehicleType: this.data.vehicleType,
      seats: this.data.seats,
      registrationDate: this.data.registrationDate,
      exteriorColor: this.data.passengerColorEnabled ? this.data.exteriorColor || null : null,
      brandId: this.data.selectedBrandId || null,
      modelId: this.data.selectedModelId || null,
      washVehicleCategory: this.data.washVehicleCategory,
      powertrainType: this.data.powertrainType,
    };
    if (!this.data.id) {
      data.isVan = this.data.vehicleType.includes("面包");
      data.isDefault = true;
    }
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
