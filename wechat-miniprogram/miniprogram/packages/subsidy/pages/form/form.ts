import { api } from "../../../../services/api";
import { storeSubsidyConsultationReceipt } from "../../../../services/storage";
import type {
  SubsidyConsultationConfig,
  SubsidyMaterialKind,
  SubsidyQuote,
  Vehicle,
} from "../../../../types";
import {
  allSubsidyMaterialsReady,
  completedSubsidyMaterialCount,
  decorateSubsidyTiers,
  defaultMaterialDefinitions,
  findSubsidyTier,
  formatDeclaredValue,
  formatSubsidyFeeBreakdown,
  MAX_DECLARED_VALUE_FEN,
  parseDeclaredValueWan,
  reconcileSubsidyUploads,
  subsidyMaterialInputMode,
  updateSubsidyUpload,
  type SubsidyTierDisplay,
  type SubsidyFeeBreakdownText,
  type SubsidyUploadItem,
} from "../../utils/consultation";

type FormField = "vehicleId" | "declaredValue" | "quote" | "contactName" | "contactPhone" | "materials" | "consentAccepted" | "legalPurposeAccepted" | "config";
type FieldErrors = Partial<Record<FormField, string>>;
type MaterialGroup = { id: string; label: string; description: string; items: SubsidyUploadItem[] };
type RequestError = Error & { code?: string; fields?: Record<string, string> };

type Data = {
  vehicles: Vehicle[];
  vehicleIndex: number;
  selectedVehicle: Vehicle | null;
  vehicleLoading: boolean;
  config: SubsidyConsultationConfig | null;
  configLoading: boolean;
  configError: string;
  tierDisplays: SubsidyTierDisplay[];
  declaredValueInput: string;
  declaredValueFen: number | null;
  localTier: SubsidyTierDisplay | null;
  quote: SubsidyQuote | null;
  quoteLoading: boolean;
  quoteError: string;
  quoteFeeBreakdown: SubsidyFeeBreakdownText | null;
  quoteValueText: string;
  quoteExpiresText: string;
  maxValueText: string;
  contactName: string;
  contactPhone: string;
  uploads: SubsidyUploadItem[];
  materialGroups: MaterialGroup[];
  completedMaterialCount: number;
  consentAccepted: boolean;
  legalPurposeAccepted: boolean;
  disclosureOpen: boolean;
  fieldErrors: FieldErrors;
  submitError: string;
  submitting: boolean;
};

const groupMeta = [
  { id: "identity", label: "身份资料", description: "身份证正反面，仅用于核对本次咨询联系人" },
  { id: "driving_license", label: "行驶证资料", description: "行驶证主页与副页，用于核对所选车辆" },
  { id: "vehicle_reference", label: "车辆参考照片", description: "仅作咨询参考，不是估值证明、资格核验或官方申报材料" },
];

function materialGroups(uploads: SubsidyUploadItem[]): MaterialGroup[] {
  return groupMeta.map((group) => ({ ...group, items: uploads.filter((item) => item.group === group.id) }));
}

function clearErrors(errors: FieldErrors, ...fields: FormField[]): FieldErrors {
  const next = { ...errors };
  fields.forEach((field) => delete next[field]);
  return next;
}

function isCancelError(error: { errMsg?: string }): boolean {
  return /cancel/i.test(String(error.errMsg || ""));
}

function localTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "10分钟内";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isQuoteExpired(quote: SubsidyQuote | null): boolean {
  if (!quote) return true;
  const expiresAt = new Date(quote.expiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

Page<Data>({
  data: {
    vehicles: [],
    vehicleIndex: 0,
    selectedVehicle: null,
    vehicleLoading: true,
    config: null,
    configLoading: false,
    configError: "",
    tierDisplays: [],
    declaredValueInput: "",
    declaredValueFen: null,
    localTier: null,
    quote: null,
    quoteLoading: false,
    quoteError: "",
    quoteFeeBreakdown: null,
    quoteValueText: "",
    quoteExpiresText: "",
    maxValueText: "50万元",
    contactName: "",
    contactPhone: "",
    uploads: reconcileSubsidyUploads(),
    materialGroups: materialGroups(reconcileSubsidyUploads()),
    completedMaterialCount: 0,
    consentAccepted: false,
    legalPurposeAccepted: false,
    disclosureOpen: false,
    fieldErrors: {},
    submitError: "",
    submitting: false,
  },

  uploadSequences: {} as Partial<Record<SubsidyMaterialKind, number>>,
  submitFingerprint: "",
  submitKey: "",

  onLoad() {
    void this.loadConfig();
  },

  onShow() {
    // Camera/album return may trigger onShow. Reloading vehicles is safe because
    // upload slots are reconciled only in loadConfig/applyUploads and never reset here.
    void this.loadVehicles();
  },

  async loadVehicles() {
    const preferredId = this.data.selectedVehicle?.id;
    this.setData({ vehicleLoading: true });
    try {
      const vehicles = await api.vehicles();
      let vehicleIndex = preferredId ? vehicles.findIndex((item) => item.id === preferredId) : -1;
      if (vehicleIndex < 0) vehicleIndex = vehicles.findIndex((item) => item.isDefault);
      if (vehicleIndex < 0) vehicleIndex = 0;
      const selectedVehicle = vehicles[vehicleIndex] || null;
      this.setData({
        vehicles,
        vehicleIndex,
        selectedVehicle,
        fieldErrors: selectedVehicle ? clearErrors(this.data.fieldErrors, "vehicleId") : this.data.fieldErrors,
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "读取车辆失败", icon: "none" });
    } finally {
      this.setData({ vehicleLoading: false });
    }
  },

  async loadConfig(force = false) {
    if (this.data.configLoading && !force) return;
    this.setData({ configLoading: true, configError: "", quote: null, quoteFeeBreakdown: null, quoteError: "" });
    try {
      const config = await api.subsidyConsultationConfig();
      if (!config.feePlan.active || !config.feePlan.tiers.length) throw new Error("补贴咨询当前暂停接收，请稍后再试");
      if (config.mode === "demo" && !config.demoContact) throw new Error("合成演示联系人配置不可用，请稍后重试");
      const maxValueFen = Math.min(config.maxDeclaredValueFen, MAX_DECLARED_VALUE_FEN);
      const declaredValueFen = parseDeclaredValueWan(this.data.declaredValueInput, maxValueFen);
      const tierDisplays = decorateSubsidyTiers(config.feePlan, declaredValueFen);
      const localTier = tierDisplays.find((item) => item.selected) || null;
      const uploads = reconcileSubsidyUploads(config.materialKinds, this.data.uploads);
      const previousDemoContact = this.data.config?.demoContact;
      const contactName = config.demoContact?.name || (previousDemoContact && this.data.contactName === previousDemoContact.name ? "" : this.data.contactName);
      const contactPhone = config.demoContact?.phone || (previousDemoContact && this.data.contactPhone === previousDemoContact.phone ? "" : this.data.contactPhone);
      this.setData({
        config,
        configError: "",
        maxValueText: formatDeclaredValue(maxValueFen),
        declaredValueFen,
        tierDisplays,
        localTier,
        uploads,
        materialGroups: materialGroups(uploads),
        completedMaterialCount: completedSubsidyMaterialCount(uploads),
        contactName,
        contactPhone,
        fieldErrors: clearErrors(this.data.fieldErrors, "config"),
      });
    } catch (error) {
      const configError = error instanceof Error ? error.message : "补贴咨询配置加载失败";
      this.setData({ config: null, configError, fieldErrors: { ...this.data.fieldErrors, config: configError } });
    } finally {
      this.setData({ configLoading: false });
    }
  },

  retryConfig() {
    void this.loadConfig(true);
  },

  changeVehicle(event) {
    const vehicleIndex = Number(event.detail.value);
    const selectedVehicle = this.data.vehicles[vehicleIndex] || null;
    if (!selectedVehicle) return;
    this.setData({
      vehicleIndex,
      selectedVehicle,
      quote: null,
      quoteError: "",
      quoteFeeBreakdown: null,
      quoteValueText: "",
      quoteExpiresText: "",
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "vehicleId", "quote"),
    });
    this.submitFingerprint = "";
    this.submitKey = "";
  },

  addVehicle() {
    wx.navigateTo({ url: "/packages/vehicle/pages/vehicle-form/vehicle-form" });
  },

  inputDeclaredValue(event) {
    const declaredValueInput = String(event.detail.value || "").replace(/[^\d.]/gu, "").slice(0, 5);
    const maxValueFen = Math.min(this.data.config?.maxDeclaredValueFen || MAX_DECLARED_VALUE_FEN, MAX_DECLARED_VALUE_FEN);
    const declaredValueFen = parseDeclaredValueWan(declaredValueInput, maxValueFen);
    const tierDisplays = this.data.config ? decorateSubsidyTiers(this.data.config.feePlan, declaredValueFen) : [];
    this.setData({
      declaredValueInput,
      declaredValueFen,
      tierDisplays,
      localTier: tierDisplays.find((item) => item.selected) || null,
      quote: null,
      quoteError: "",
      quoteFeeBreakdown: null,
      quoteValueText: "",
      quoteExpiresText: "",
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "declaredValue", "quote"),
    });
    this.submitFingerprint = "";
    this.submitKey = "";
  },

  blurDeclaredValue() {
    if (!this.data.declaredValueInput) return;
    if (!this.data.declaredValueFen || !this.data.localTier) {
      this.setData({ fieldErrors: { ...this.data.fieldErrors, declaredValue: `请输入0到${this.data.maxValueText}之间的估值，最多1位小数` } });
    }
  },

  async confirmQuote() {
    if (this.data.quoteLoading) return;
    const selectedVehicle = this.data.selectedVehicle;
    const config = this.data.config;
    const declaredValueFen = this.data.declaredValueFen;
    const fieldErrors = { ...this.data.fieldErrors };
    if (!selectedVehicle) fieldErrors.vehicleId = "请先选择咨询车辆";
    if (!config) fieldErrors.config = this.data.configError || "请先加载咨询配置";
    if (!declaredValueFen || !findSubsidyTier(config?.feePlan.tiers || [], declaredValueFen)) {
      fieldErrors.declaredValue = `请输入0到${this.data.maxValueText}之间的估值，最多1位小数`;
    }
    this.setData({ fieldErrors, quoteError: "" });
    if (!selectedVehicle || !config || !declaredValueFen || fieldErrors.declaredValue) return;

    this.setData({ quoteLoading: true, quote: null });
    try {
      const quote = await api.subsidyConsultationQuote({ vehicleId: selectedVehicle.id, declaredValueFen });
      if (!quote.id || quote.vehicleId !== selectedVehicle.id || quote.declaredValueFen !== declaredValueFen) {
        throw new Error("服务端报价与当前车辆估值不一致，请重新获取");
      }
      this.setData({
        quote,
        quoteFeeBreakdown: formatSubsidyFeeBreakdown(quote),
        quoteValueText: formatDeclaredValue(quote.declaredValueFen),
        quoteExpiresText: localTime(quote.expiresAt),
        quoteError: "",
        fieldErrors: clearErrors(this.data.fieldErrors, "quote", "declaredValue"),
      });
    } catch (error) {
      const quoteError = error instanceof Error ? error.message : "获取咨询价失败，请稍后重试";
      this.setData({ quote: null, quoteError, fieldErrors: { ...this.data.fieldErrors, quote: quoteError } });
    } finally {
      this.setData({ quoteLoading: false });
    }
  },

  inputName(event) {
    if (this.data.config?.demoContact) return;
    this.setData({
      contactName: String(event.detail.value || "").slice(0, 30),
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "contactName"),
    });
  },

  inputPhone(event) {
    if (this.data.config?.demoContact) return;
    this.setData({
      contactPhone: String(event.detail.value || "").replace(/\D/gu, "").slice(0, 11),
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "contactPhone"),
    });
  },

  applyUploads(uploads: SubsidyUploadItem[]) {
    this.setData({
      uploads,
      materialGroups: materialGroups(uploads),
      completedMaterialCount: completedSubsidyMaterialCount(uploads),
      submitError: "",
      fieldErrors: allSubsidyMaterialsReady(uploads) ? clearErrors(this.data.fieldErrors, "materials") : this.data.fieldErrors,
    });
  },

  chooseMaterial(event) {
    const kind = String(event.currentTarget.dataset.kind || "") as SubsidyMaterialKind;
    const current = this.data.uploads.find((item) => item.kind === kind);
    if (!current || current.uploading) return;
    const config = this.data.config;
    if (!config) {
      wx.showToast({ title: "请先等待咨询配置加载", icon: "none" });
      return;
    }
    if (subsidyMaterialInputMode(config.acceptsRealData, config.materialUploadMode) === "server_generated_demo") {
      void this.useDemoMaterial(kind);
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: ({ tempFiles }) => {
        const file = tempFiles[0];
        if (!file?.tempFilePath) return;
        if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
          wx.showToast({ title: "单张图片需小于5MB", icon: "none" });
          this.applyUploads(updateSubsidyUpload(this.data.uploads, kind, { error: "单张图片需小于5MB" }));
          return;
        }
        void this.uploadChosenMaterial(kind, file.tempFilePath, file.size);
      },
      fail: (error) => {
        if (!isCancelError(error)) wx.showToast({ title: error.errMsg || "选择图片失败", icon: "none" });
      },
    });
  },

  async useDemoMaterial(kind: SubsidyMaterialKind) {
    const previous = this.data.uploads.find((item) => item.kind === kind);
    if (!previous) return;
    const sequence = (this.uploadSequences[kind] || 0) + 1;
    this.uploadSequences[kind] = sequence;
    this.applyUploads(updateSubsidyUpload(this.data.uploads, kind, { uploading: true, error: "" }));
    try {
      const material = await api.createDemoSubsidyConsultationMaterial(kind);
      if (this.uploadSequences[kind] !== sequence) return;
      if (material.kind !== kind) {
        void api.deleteSubsidyConsultationMaterial(material.id).catch(() => undefined);
        throw new Error("服务端返回的演示资料类型不一致，请重试");
      }
      this.applyUploads(updateSubsidyUpload(this.data.uploads, kind, {
        localPath: "",
        fileSize: material.sizeBytes,
        material,
        uploading: false,
        error: "",
      }));
      if (previous.material?.id && previous.material.id !== material.id) {
        void api.deleteSubsidyConsultationMaterial(previous.material.id).catch(() => undefined);
      }
    } catch (error) {
      if (this.uploadSequences[kind] !== sequence) return;
      const message = error instanceof Error ? error.message : "合成演示资料生成失败";
      this.applyUploads(updateSubsidyUpload(this.data.uploads, kind, {
        localPath: previous.localPath,
        fileSize: previous.fileSize,
        material: previous.material,
        uploading: false,
        error: message,
      }));
      wx.showToast({ title: message, icon: "none" });
    }
  },

  async uploadChosenMaterial(kind: SubsidyMaterialKind, filePath: string, fileSize: number) {
    const previous = this.data.uploads.find((item) => item.kind === kind);
    if (!previous) return;
    const sequence = (this.uploadSequences[kind] || 0) + 1;
    this.uploadSequences[kind] = sequence;
    this.applyUploads(updateSubsidyUpload(this.data.uploads, kind, {
      localPath: filePath,
      fileSize,
      uploading: true,
      error: "",
    }));
    try {
      const material = await api.uploadSubsidyConsultationMaterial(kind, filePath);
      if (this.uploadSequences[kind] !== sequence) return;
      if (material.kind !== kind) {
        void api.deleteSubsidyConsultationMaterial(material.id).catch(() => undefined);
        throw new Error("服务端返回的资料类型不一致，请重新上传");
      }
      const currentUploads = updateSubsidyUpload(this.data.uploads, kind, { material, uploading: false, error: "" });
      this.applyUploads(currentUploads);
      if (previous.material?.id && previous.material.id !== material.id) {
        void api.deleteSubsidyConsultationMaterial(previous.material.id).catch(() => undefined);
      }
    } catch (error) {
      if (this.uploadSequences[kind] !== sequence) return;
      const message = error instanceof Error ? error.message : "资料上传失败";
      this.applyUploads(updateSubsidyUpload(this.data.uploads, kind, {
        localPath: previous.localPath,
        fileSize: previous.fileSize,
        material: previous.material,
        uploading: false,
        error: message,
      }));
      wx.showToast({ title: message, icon: "none" });
    }
  },

  previewMaterial(event) {
    const kind = String(event.currentTarget.dataset.kind || "") as SubsidyMaterialKind;
    const item = this.data.uploads.find((upload) => upload.kind === kind);
    if (!item?.localPath) return;
    const urls = this.data.uploads.map((upload) => upload.localPath).filter(Boolean);
    wx.previewImage({ current: item.localPath, urls });
  },

  removeMaterial(event) {
    const kind = String(event.currentTarget.dataset.kind || "") as SubsidyMaterialKind;
    const item = this.data.uploads.find((upload) => upload.kind === kind);
    if (!item) return;
    this.uploadSequences[kind] = (this.uploadSequences[kind] || 0) + 1;
    this.applyUploads(updateSubsidyUpload(this.data.uploads, kind, {
      localPath: "",
      fileSize: 0,
      material: null,
      uploading: false,
      error: "",
    }));
    if (item.material?.id) {
      void api.deleteSubsidyConsultationMaterial(item.material.id).catch(() => {
        wx.showToast({ title: "资料已从本页移除，暂存文件将自动清理", icon: "none" });
      });
    }
  },

  toggleConsent() {
    this.setData({
      consentAccepted: !this.data.consentAccepted,
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "consentAccepted"),
    });
  },

  toggleLegalPurpose() {
    this.setData({
      legalPurposeAccepted: !this.data.legalPurposeAccepted,
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "legalPurposeAccepted"),
    });
  },

  showDisclosure() {
    this.setData({ disclosureOpen: true });
  },

  closeDisclosure() {
    this.setData({ disclosureOpen: false });
  },

  acceptDisclosure() {
    if (!this.data.config) return;
    this.setData({
      consentAccepted: true,
      disclosureOpen: false,
      fieldErrors: clearErrors(this.data.fieldErrors, "consentAccepted", "config"),
    });
  },

  copyOfficialSource() {
    const url = this.data.config?.disclosure.officialSourceUrl;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: "政府官方来源链接已复制", icon: "success" }),
    });
  },

  noop() {},

  validate(): FieldErrors {
    const errors: FieldErrors = {};
    const config = this.data.config;
    if (!this.data.selectedVehicle) errors.vehicleId = "请选择咨询车辆";
    if (!config) errors.config = this.data.configError || "补贴咨询配置暂不可用";
    if (!this.data.declaredValueFen || !findSubsidyTier(config?.feePlan.tiers || [], this.data.declaredValueFen)) {
      errors.declaredValue = `请输入0到${this.data.maxValueText}之间的估值，最多1位小数`;
    }
    if (!this.data.quote || this.data.quote.declaredValueFen !== this.data.declaredValueFen || isQuoteExpired(this.data.quote)) {
      errors.quote = isQuoteExpired(this.data.quote) && this.data.quote ? "咨询价已过期，请重新获取" : "请先获取服务端咨询价";
    }
    const name = this.data.contactName.trim();
    if (!name || name.length > 30) errors.contactName = "请填写1–30个字符的姓名";
    if (!/^1[3-9]\d{9}$/u.test(this.data.contactPhone)) errors.contactPhone = "请输入正确的11位手机号";
    if (config?.demoContact && (name !== config.demoContact.name || this.data.contactPhone !== config.demoContact.phone)) {
      errors.contactName = "演示模式必须使用服务端提供的合成联系人";
      errors.contactPhone = "演示模式必须使用服务端提供的合成联系电话";
    }
    if (!allSubsidyMaterialsReady(this.data.uploads)) {
      const missing = this.data.uploads.find((item) => !item.material);
      errors.materials = this.data.uploads.some((item) => item.uploading) ? "请等待资料上传完成" : `请上传${missing?.label || "全部九项资料"}`;
    }
    if (!this.data.consentAccepted) errors.consentAccepted = "请先阅读并同意敏感信息使用说明";
    if (!this.data.legalPurposeAccepted) errors.legalPurposeAccepted = "请确认资料真实且仅用于合法咨询";
    return errors;
  },

  async submit() {
    if (this.data.submitting) return;
    const errors = this.validate();
    this.setData({ fieldErrors: errors, submitError: "" });
    if (Object.keys(errors).length) {
      wx.showToast({ title: errors.quote || errors.materials || "请完善咨询资料", icon: "none" });
      return;
    }

    const quote = this.data.quote!;
    const config = this.data.config!;
    const contactName = this.data.contactName.trim();
    const materialIds = this.data.uploads.map((item) => item.material!.id);
    const fingerprint = JSON.stringify({ quoteId: quote.id, materialIds, contactName, contactPhone: this.data.contactPhone, disclosureVersion: config.disclosure.version });
    if (this.submitFingerprint !== fingerprint) {
      this.submitFingerprint = fingerprint;
      this.submitKey = `subsidy-consultation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    this.setData({ submitting: true });
    try {
      const receipt = await api.createSubsidyConsultation({
        quoteId: quote.id,
        materialIds,
        contactName,
        contactPhone: this.data.contactPhone,
        disclosureVersion: config.disclosure.version,
        consentAccepted: true,
        legalPurposeAccepted: true,
      }, this.submitKey);
      if (!receipt.id || !receipt.consultationCode) throw new Error("提交成功但未返回咨询凭证，请稍后重试");
      storeSubsidyConsultationReceipt(receipt);
      wx.redirectTo({ url: `/packages/subsidy/pages/receipt/receipt?id=${encodeURIComponent(receipt.id)}` });
    } catch (error) {
      const requestError = error as RequestError;
      let message = requestError.message || "咨询提交失败，请稍后重试";
      let fieldErrors = { ...this.data.fieldErrors };
      if (["QUOTE_EXPIRED", "QUOTE_NOT_FOUND", "QUOTE_PLAN_STALE", "SUBSIDY_QUOTE_EXPIRED", "SUBSIDY_QUOTE_NOT_FOUND", "SUBSIDY_QUOTE_ALREADY_USED"].includes(requestError.code || "")) {
        message = "咨询价已失效，请按当前后台价格重新获取";
        fieldErrors.quote = message;
        this.setData({ quote: null, quoteFeeBreakdown: null, quoteValueText: "", quoteExpiresText: "" });
      } else if (["DISCLOSURE_VERSION_MISMATCH", "SUBSIDY_DISCLOSURE_VERSION_MISMATCH"].includes(requestError.code || "")) {
        message = "信息使用说明已更新，请重新阅读并授权";
        fieldErrors.consentAccepted = message;
        this.setData({ consentAccepted: false });
        void this.loadConfig(true);
      } else if (["MATERIALS_INCOMPLETE", "MATERIAL_NOT_FOUND", "MATERIAL_EXPIRED", "SUBSIDY_MEDIA_IDS_INVALID", "SUBSIDY_MEDIA_NOT_AVAILABLE", "SUBSIDY_MEDIA_REQUIRED", "SUBSIDY_MEDIA_MODE_CHANGED"].includes(requestError.code || "")) {
        fieldErrors.materials = message;
      } else if (requestError.code === "REAL_DATA_NOT_ACCEPTED") {
        message = "演示环境仅接受合成资料，联系电话请使用 13800138000";
        fieldErrors.contactPhone = message;
      } else if (requestError.code === "SUBSIDY_CONSULTATION_ALREADY_OPEN") {
        message = "该车辆已有一条待处理咨询，请勿重复提交";
      } else if (requestError.fields) {
        fieldErrors = { ...fieldErrors, ...requestError.fields };
      }
      this.setData({ submitError: message, fieldErrors });
      wx.showToast({ title: message, icon: "none", duration: 2800 });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
