import { api } from "../../../../services/api";
import { storeInsuranceReceipt } from "../../../../services/storage";
import type {
  InsuranceContactWindow,
  InsuranceDisclosure,
  InsuranceRenewalWindow,
  Vehicle,
} from "../../../../types";

type InsuranceFieldErrors = Partial<Record<
  "vehicleId" | "contactName" | "contactPhone" | "licensePhoto" | "consentAccepted" | "disclosure",
  string
>>;

type RenewalOption = { value: InsuranceRenewalWindow; label: string };
type ContactOption = { value: InsuranceContactWindow; label: string; copy: string; icon: string };

type Data = {
  vehicles: Vehicle[];
  vehicleIndex: number;
  selectedVehicle: Vehicle | null;
  vehicleLoading: boolean;
  renewalOptions: RenewalOption[];
  renewalWindow: InsuranceRenewalWindow;
  contactOptions: ContactOption[];
  contactWindow: InsuranceContactWindow;
  contactName: string;
  contactPhone: string;
  licensePhotoPath: string;
  licensePhotoName: string;
  licensePhotoSize: number;
  licensePhotoSizeText: string;
  consentAccepted: boolean;
  disclosure: InsuranceDisclosure | null;
  disclosureLoading: boolean;
  disclosureError: string;
  disclosureOpen: boolean;
  fieldErrors: InsuranceFieldErrors;
  submitError: string;
  submitting: boolean;
};

type RequestError = Error & { code?: string; fields?: Record<string, string> };

function clearErrors(errors: InsuranceFieldErrors, ...fields: Array<keyof InsuranceFieldErrors>): InsuranceFieldErrors {
  const next = { ...errors };
  for (const field of fields) delete next[field];
  return next;
}

const renewalOptions: RenewalOption[] = [
  { value: "within_30_days", label: "30天内" },
  { value: "one_to_three_months", label: "1–3个月" },
  { value: "over_three_months", label: "3个月以上" },
];

const contactOptions: ContactOption[] = [
  { value: "morning", label: "上午", copy: "9:00–12:00", icon: "/assets/icons/sun.png" },
  { value: "afternoon", label: "下午", copy: "12:00–18:00", icon: "/assets/icons/clock.png" },
  { value: "evening", label: "晚上", copy: "18:00–21:00", icon: "/assets/icons/moon.png" },
  { value: "anytime", label: "任意时间", copy: "均可联系", icon: "/assets/icons/phone.png" },
];

function photoSizeText(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${(size / 1024 / 1024).toFixed(2)}MB`;
}

function photoName(path: string): string {
  const clean = path.split("?")[0];
  const name = clean.split(/[\\/]/).pop() || "行驶证主页";
  return name.length > 28 ? `${name.slice(0, 24)}…` : name;
}

function isCancelError(error: { errMsg?: string }): boolean {
  return /cancel/i.test(String(error.errMsg || ""));
}

Page<Data>({
  data: {
    vehicles: [],
    vehicleIndex: 0,
    selectedVehicle: null,
    vehicleLoading: true,
    renewalOptions,
    renewalWindow: "within_30_days",
    contactOptions,
    contactWindow: "morning",
    contactName: "",
    contactPhone: "",
    licensePhotoPath: "",
    licensePhotoName: "",
    licensePhotoSize: 0,
    licensePhotoSizeText: "",
    consentAccepted: false,
    disclosure: null,
    disclosureLoading: false,
    disclosureError: "",
    disclosureOpen: false,
    fieldErrors: {},
    submitError: "",
    submitting: false,
  },

  onLoad() {
    void this.loadDisclosure();
  },

  onShow() {
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
      const fieldErrors = selectedVehicle ? clearErrors(this.data.fieldErrors, "vehicleId") : this.data.fieldErrors;
      this.setData({ vehicles, vehicleIndex, selectedVehicle, fieldErrors });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "读取车辆失败", icon: "none" });
    } finally {
      this.setData({ vehicleLoading: false });
    }
  },

  async loadDisclosure(force = false) {
    if (this.data.disclosureLoading || (this.data.disclosure && !force)) return;
    this.setData({
      disclosure: force ? null : this.data.disclosure,
      disclosureLoading: true,
      disclosureError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "disclosure"),
    });
    try {
      const disclosure = await api.insuranceDisclosure();
      this.setData({ disclosure, disclosureError: "" });
    } catch (error) {
      const disclosureError = error instanceof Error ? error.message : "信息使用说明加载失败，请重试";
      this.setData({
        disclosure: null,
        disclosureError,
        fieldErrors: { ...this.data.fieldErrors, disclosure: disclosureError },
      });
    } finally {
      this.setData({ disclosureLoading: false });
    }
  },

  changeVehicle(event) {
    const vehicleIndex = Number(event.detail.value);
    const selectedVehicle = this.data.vehicles[vehicleIndex] || null;
    if (!selectedVehicle) return;
    this.setData({
      vehicleIndex,
      selectedVehicle,
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "vehicleId"),
    });
  },

  addVehicle() {
    wx.navigateTo({ url: "/packages/vehicle/pages/vehicle-form/vehicle-form" });
  },

  chooseRenewal(event) {
    const value = String(event.currentTarget.dataset.value || "") as InsuranceRenewalWindow;
    if (!renewalOptions.some((item) => item.value === value)) return;
    this.setData({ renewalWindow: value, submitError: "" });
  },

  chooseContactWindow(event) {
    const value = String(event.currentTarget.dataset.value || "") as InsuranceContactWindow;
    if (!contactOptions.some((item) => item.value === value)) return;
    this.setData({ contactWindow: value, submitError: "" });
  },

  inputName(event) {
    const contactName = String(event.detail.value || "").slice(0, 30);
    this.setData({
      contactName,
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "contactName"),
    });
  },

  inputPhone(event) {
    const contactPhone = String(event.detail.value || "").replace(/\D/gu, "").slice(0, 11);
    this.setData({
      contactPhone,
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "contactPhone"),
    });
  },

  choosePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const file = result.tempFiles[0];
        if (!file?.tempFilePath) return;
        if (file.size > 5 * 1024 * 1024) {
          this.setData({
            licensePhotoPath: "",
            licensePhotoName: "",
            licensePhotoSize: 0,
            licensePhotoSizeText: "",
            fieldErrors: { ...this.data.fieldErrors, licensePhoto: "图片大小不能超过5MB" },
          });
          wx.showToast({ title: "图片大小不能超过5MB", icon: "none" });
          return;
        }
        this.setData({
          licensePhotoPath: file.tempFilePath,
          licensePhotoName: photoName(file.tempFilePath),
          licensePhotoSize: file.size,
          licensePhotoSizeText: photoSizeText(file.size),
          submitError: "",
          fieldErrors: clearErrors(this.data.fieldErrors, "licensePhoto"),
        });
      },
      fail: (error) => {
        if (!isCancelError(error)) wx.showToast({ title: error.errMsg || "选择图片失败", icon: "none" });
      },
    });
  },

  previewPhoto() {
    if (!this.data.licensePhotoPath) return;
    wx.previewImage({ current: this.data.licensePhotoPath, urls: [this.data.licensePhotoPath] });
  },

  removePhoto() {
    this.setData({
      licensePhotoPath: "",
      licensePhotoName: "",
      licensePhotoSize: 0,
      licensePhotoSizeText: "",
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "licensePhoto"),
    });
  },

  toggleConsent() {
    if (!this.data.disclosure) {
      this.setData({ disclosureOpen: true });
      if (!this.data.disclosureLoading) void this.loadDisclosure(true);
      return;
    }
    this.setData({
      consentAccepted: !this.data.consentAccepted,
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "consentAccepted"),
    });
  },

  showDisclosure() {
    this.setData({ disclosureOpen: true });
    if (!this.data.disclosure && !this.data.disclosureLoading) void this.loadDisclosure(true);
  },

  closeDisclosure() {
    this.setData({ disclosureOpen: false });
  },

  acceptDisclosure() {
    if (!this.data.disclosure) return;
    this.setData({
      consentAccepted: true,
      disclosureOpen: false,
      submitError: "",
      fieldErrors: clearErrors(this.data.fieldErrors, "consentAccepted", "disclosure"),
    });
  },

  retryDisclosure() {
    void this.loadDisclosure(true);
  },

  noop() {},

  validate(): InsuranceFieldErrors {
    const errors: InsuranceFieldErrors = {};
    if (!this.data.selectedVehicle) errors.vehicleId = "请选择需要续保对接的车辆";
    const name = this.data.contactName.trim();
    if (!name || name.length > 30) errors.contactName = "请填写1–30个字符的联系人姓名";
    if (!/^1[3-9]\d{9}$/u.test(this.data.contactPhone)) errors.contactPhone = "请输入正确的11位手机号";
    if (!this.data.licensePhotoPath) errors.licensePhoto = "请上传1张行驶证主页";
    else if (this.data.licensePhotoSize > 5 * 1024 * 1024) errors.licensePhoto = "图片大小不能超过5MB";
    if (!this.data.consentAccepted) errors.consentAccepted = "请先阅读并同意信息使用说明";
    if (!this.data.disclosure) {
      errors.disclosure = this.data.disclosureLoading
        ? "信息使用说明正在加载，请稍候"
        : this.data.disclosureError || "请先加载信息使用说明";
    }
    return errors;
  },

  async submit() {
    if (this.data.submitting) return;
    const errors = this.validate();
    this.setData({ fieldErrors: errors, submitError: "" });
    if (Object.keys(errors).length) {
      wx.showToast({ title: "请完善续保需求信息", icon: "none" });
      return;
    }

    const vehicle = this.data.selectedVehicle!;
    const disclosure = this.data.disclosure!;
    const contactName = this.data.contactName.trim();
    const fingerprint = JSON.stringify({
      vehicleId: vehicle.id,
      renewalWindow: this.data.renewalWindow,
      contactName,
      contactPhone: this.data.contactPhone,
      contactWindow: this.data.contactWindow,
      disclosureVersion: disclosure.version,
      licensePhotoPath: this.data.licensePhotoPath,
      licensePhotoSize: this.data.licensePhotoSize,
    });
    if (this.submitFingerprint !== fingerprint) {
      this.submitFingerprint = fingerprint;
      this.submitKey = `insurance-lead-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    this.setData({ submitting: true });
    try {
      const receipt = await api.createInsuranceLead({
        vehicleId: vehicle.id,
        renewalWindow: this.data.renewalWindow,
        contactName,
        contactPhone: this.data.contactPhone,
        contactWindow: this.data.contactWindow,
        consentAccepted: true,
        disclosureVersion: disclosure.version,
      }, this.data.licensePhotoPath, String(this.submitKey));
      storeInsuranceReceipt(receipt);
      wx.redirectTo({ url: "/packages/insurance/pages/insurance-receipt/insurance-receipt" });
    } catch (error) {
      const requestError = error as RequestError;
      let message = requestError.message || "续保需求提交失败，请稍后重试";
      let fieldErrors = { ...this.data.fieldErrors };
      if (requestError.code === "DISCLOSURE_VERSION_MISMATCH") {
        message = "信息使用说明已更新，请重新阅读并授权后提交";
        fieldErrors = { ...fieldErrors, consentAccepted: message };
        this.setData({ consentAccepted: false });
        void this.loadDisclosure(true);
      } else if (["REAL_DATA_NOT_ACCEPTED", "DEMO_DATA_ONLY"].includes(requestError.code || "")) {
        message = "演示环境仅支持合成演示号码13800138000或13900000000";
        fieldErrors = { ...fieldErrors, contactPhone: message };
      } else if (["INVALID_MEDIA_TYPE", "INVALID_MEDIA", "MEDIA_TOO_LARGE", "LICENSE_PHOTO_REQUIRED"].includes(requestError.code || "")) {
        fieldErrors = { ...fieldErrors, licensePhoto: message };
      } else if (requestError.code === "VEHICLE_NOT_FOUND") {
        fieldErrors = { ...fieldErrors, vehicleId: message };
      } else if (requestError.code === "IDEMPOTENCY_KEY_CONFLICT") {
        message = "提交内容已变化，请确认信息后重新提交";
        this.submitFingerprint = "";
        this.submitKey = "";
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
