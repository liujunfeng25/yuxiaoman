import { api } from "../../../../services/api";
import { storeDrivingSchoolReceipt, storeRecentContact } from "../../../../services/storage";
import type {
  DrivingSchoolApplicationMode,
  DrivingSchoolContactWindow,
  DrivingSchoolDetail,
  DrivingSchoolInquiryDisclosure,
  DrivingSchoolTrainingClass,
} from "../../../../types";
import { applicationModeLabel, errorKind, localDrivingSchoolCover, resolveDrivingSchoolCover } from "../../utils";

type FieldErrors = Partial<Record<"licenseClassCode" | "contactName" | "contactPhone" | "consentAccepted" | "disclosure", string>>;
type ClassOption = DrivingSchoolTrainingClass & { label: string };
type OfferOption = { id: string; label: string };
type ContactOption = { value: DrivingSchoolContactWindow; label: string; copy: string; icon: string };

type Data = {
  schoolId: string;
  school: DrivingSchoolDetail | null;
  coverImage: string;
  applicationMode: DrivingSchoolApplicationMode;
  classOptions: ClassOption[];
  licenseClassIndex: number;
  licenseClassCode: string;
  offerOptions: OfferOption[];
  offerIndex: number;
  offerId: string;
  contactOptions: ContactOption[];
  contactWindow: DrivingSchoolContactWindow;
  contactName: string;
  contactPhone: string;
  message: string;
  disclosure: DrivingSchoolInquiryDisclosure | null;
  consentAccepted: boolean;
  disclosureOpen: boolean;
  loading: boolean;
  submitting: boolean;
  error: string;
  stateKind: "offline" | "not_found" | "error" | "";
  submitError: string;
  fieldErrors: FieldErrors;
};

const contactOptions: ContactOption[] = [
  { value: "morning", label: "上午", copy: "9:00–12:00", icon: "/assets/icons/sun.png" },
  { value: "afternoon", label: "下午", copy: "12:00–18:00", icon: "/assets/icons/clock.png" },
  { value: "evening", label: "晚上", copy: "18:00–21:00", icon: "/assets/icons/moon.png" },
  { value: "anytime", label: "任意时间", copy: "均可联系", icon: "/assets/icons/phone.png" },
];

function classOptionsFor(school: DrivingSchoolDetail, mode: DrivingSchoolApplicationMode): ClassOption[] {
  return school.trainingClasses
    .filter((item) => !item.supportedModes.length || item.supportedModes.includes(mode))
    .map((item) => ({ ...item, label: `${item.licenseClassCode} · ${item.name}` }));
}

function selectionFor(school: DrivingSchoolDetail, mode: DrivingSchoolApplicationMode, preferredCode = "", preferredOfferId = "") {
  const classOptions = classOptionsFor(school, mode);
  const licenseClassIndex = Math.max(0, classOptions.findIndex((item) => item.licenseClassCode === preferredCode));
  const licenseClassCode = classOptions[licenseClassIndex]?.licenseClassCode || "";
  const offerOptions: OfferOption[] = [
    { id: "", label: "暂不指定报价项目" },
    ...school.offers.filter((item) => item.status === "active" && item.licenseClassCode === licenseClassCode && (!item.applicationModes.length || item.applicationModes.includes(mode))).map((item) => ({ id: item.id, label: item.name })),
  ];
  const offerIndex = Math.max(0, offerOptions.findIndex((item) => item.id === preferredOfferId));
  return { classOptions, licenseClassIndex, licenseClassCode, offerOptions, offerIndex, offerId: offerOptions[offerIndex]?.id || "" };
}

function withoutErrors(errors: FieldErrors, ...keys: Array<keyof FieldErrors>): FieldErrors {
  const next = { ...errors };
  keys.forEach((key) => delete next[key]);
  return next;
}

Page<Data>({
  requestedClassCode: "",
  requestedOfferId: "",
  requestedApplicationMode: "initial" as DrivingSchoolApplicationMode,
  submitFingerprint: "",
  submitKey: "",

  data: {
    schoolId: "", school: null, coverImage: "", applicationMode: "initial",
    classOptions: [], licenseClassIndex: 0, licenseClassCode: "",
    offerOptions: [{ id: "", label: "暂不指定报价项目" }], offerIndex: 0, offerId: "",
    contactOptions, contactWindow: "anytime", contactName: "", contactPhone: "", message: "",
    disclosure: null, consentAccepted: false, disclosureOpen: false,
    loading: true, submitting: false, error: "", stateKind: "", submitError: "", fieldErrors: {},
  },

  onLoad(query) {
    const schoolId = String(query.schoolId || "");
    this.requestedClassCode = String(query.licenseClassCode || "");
    this.requestedOfferId = String(query.offerId || "");
    this.requestedApplicationMode = String(query.applicationMode || "initial") === "upgrade" ? "upgrade" : "initial";
    this.setData({ schoolId });
    if (!schoolId) {
      this.setData({ loading: false, error: "缺少驾校编号", stateKind: "not_found" });
      return;
    }
    void this.load();
  },

  async load() {
    this.setData({ loading: true, error: "", stateKind: "" });
    try {
      const [school, disclosure] = await Promise.all([
        api.drivingSchool(this.data.schoolId),
        api.drivingSchoolInquiryDisclosure(this.data.schoolId),
      ]);
      const preferredClass = school.trainingClasses.find((item) => item.licenseClassCode === this.requestedClassCode);
      const applicationMode: DrivingSchoolApplicationMode = preferredClass?.supportedModes.includes(this.requestedApplicationMode)
        ? this.requestedApplicationMode
        : preferredClass?.supportedModes.includes("initial") === false && preferredClass.supportedModes.includes("upgrade") ? "upgrade" : "initial";
      this.setData({
        school,
        disclosure,
        applicationMode,
        coverImage: resolveDrivingSchoolCover(school),
        consentAccepted: false,
        ...selectionFor(school, applicationMode, this.requestedClassCode, this.requestedOfferId),
      });
      wx.setNavigationBarTitle({ title: `咨询 · ${school.name}` });
    } catch (error) {
      this.setData({
        school: null,
        disclosure: null,
        error: error instanceof Error ? error.message : "咨询信息暂时无法读取",
        stateKind: errorKind(error),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  retry() { void this.load(); },
  back() { wx.navigateBack(); },
  imageError() {
    if (this.data.school) this.setData({ coverImage: localDrivingSchoolCover(this.data.school.trainingClasses, this.data.school.id) });
  },
  chooseMode(event) {
    const applicationMode = String(event.currentTarget.dataset.mode || "initial") as DrivingSchoolApplicationMode;
    if (!this.data.school || applicationMode === this.data.applicationMode) return;
    this.setData({
      applicationMode,
      consentAccepted: false,
      fieldErrors: withoutErrors(this.data.fieldErrors, "licenseClassCode"),
      ...selectionFor(this.data.school, applicationMode),
    });
  },
  classChange(event) {
    if (!this.data.school) return;
    const licenseClassIndex = Number(event.detail.value || 0);
    const selected = this.data.classOptions[licenseClassIndex];
    if (!selected) return;
    const next = selectionFor(this.data.school, this.data.applicationMode, selected.licenseClassCode);
    this.setData({ ...next, fieldErrors: withoutErrors(this.data.fieldErrors, "licenseClassCode"), submitError: "" });
  },
  offerChange(event) {
    const offerIndex = Number(event.detail.value || 0);
    const option = this.data.offerOptions[offerIndex] || this.data.offerOptions[0];
    this.setData({ offerIndex, offerId: option.id, submitError: "" });
  },
  chooseWindow(event) {
    const contactWindow = String(event.currentTarget.dataset.value || "anytime") as DrivingSchoolContactWindow;
    if (contactOptions.some((item) => item.value === contactWindow)) this.setData({ contactWindow, submitError: "" });
  },
  nameInput(event) {
    this.setData({ contactName: String(event.detail.value || "").slice(0, 30), fieldErrors: withoutErrors(this.data.fieldErrors, "contactName"), submitError: "" });
  },
  phoneInput(event) {
    this.setData({ contactPhone: String(event.detail.value || "").replace(/\D/gu, "").slice(0, 11), fieldErrors: withoutErrors(this.data.fieldErrors, "contactPhone"), submitError: "" });
  },
  fillDemoContact() {
    if (this.data.disclosure?.acceptsRealData !== false) return;
    this.setData({
      contactName: "演示车主",
      contactPhone: "13800138000",
      fieldErrors: withoutErrors(this.data.fieldErrors, "contactName", "contactPhone"),
      submitError: "",
    });
    wx.showToast({ title: "已填入演示资料，不会真实外呼", icon: "none" });
  },
  messageInput(event) { this.setData({ message: String(event.detail.value || "").slice(0, 300), submitError: "" }); },
  toggleConsent() {
    if (!this.data.disclosure) { this.setData({ disclosureOpen: true }); return; }
    this.setData({ consentAccepted: !this.data.consentAccepted, fieldErrors: withoutErrors(this.data.fieldErrors, "consentAccepted", "disclosure"), submitError: "" });
  },
  showDisclosure() { this.setData({ disclosureOpen: true }); },
  closeDisclosure() { this.setData({ disclosureOpen: false }); },
  acceptDisclosure() {
    if (!this.data.disclosure) return;
    this.setData({ consentAccepted: true, disclosureOpen: false, fieldErrors: withoutErrors(this.data.fieldErrors, "consentAccepted", "disclosure"), submitError: "" });
  },
  noop() {},

  validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!this.data.licenseClassCode) errors.licenseClassCode = "请选择要咨询的准驾车型";
    const name = this.data.contactName.trim();
    if (!name || name.length > 30) errors.contactName = "请填写 1–30 个字符的联系人姓名";
    if (!/^1[3-9]\d{9}$/u.test(this.data.contactPhone)) errors.contactPhone = "请输入正确的 11 位手机号";
    if (!this.data.disclosure) errors.disclosure = "信息使用说明尚未加载";
    if (!this.data.consentAccepted) errors.consentAccepted = "请先阅读并同意信息使用说明";
    return errors;
  },

  async submit() {
    if (this.data.submitting) return;
    const fieldErrors = this.validate();
    this.setData({ fieldErrors, submitError: "" });
    if (Object.keys(fieldErrors).length) { wx.showToast({ title: "请完善咨询信息", icon: "none" }); return; }
    const school = this.data.school!;
    const disclosure = this.data.disclosure!;
    const contactName = this.data.contactName.trim();
    const message = this.data.message.trim();
    const fingerprint = JSON.stringify({
      schoolId: school.id, licenseClassCode: this.data.licenseClassCode, offerId: this.data.offerId,
      applicationMode: this.data.applicationMode, contactName, contactPhone: this.data.contactPhone,
      contactWindow: this.data.contactWindow, message, disclosureVersion: disclosure.version,
    });
    if (this.submitFingerprint !== fingerprint) {
      this.submitFingerprint = fingerprint;
      this.submitKey = `driving-school-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    this.setData({ submitting: true });
    try {
      const receipt = await api.createDrivingSchoolInquiry({
        schoolId: school.id,
        licenseClassCode: this.data.licenseClassCode,
        ...(this.data.offerId ? { offerId: this.data.offerId } : {}),
        applicationMode: this.data.applicationMode,
        contactName,
        contactPhone: this.data.contactPhone,
        contactWindow: this.data.contactWindow,
        ...(message ? { message } : {}),
        disclosureVersion: disclosure.version,
        consentAccepted: true,
      }, String(this.submitKey));
      storeRecentContact({ name: contactName, phone: this.data.contactPhone });
      storeDrivingSchoolReceipt(receipt);
      wx.redirectTo({ url: "/packages/driving-school/pages/receipt/receipt" });
    } catch (error) {
      const requestError = error as Error & { code?: string; fields?: Record<string, string> };
      let messageText = requestError.message || "咨询提交失败，请稍后重试";
      let nextErrors = { ...this.data.fieldErrors };
      if (requestError.code === "DISCLOSURE_VERSION_MISMATCH") {
        messageText = "信息使用说明已更新，请重新阅读后提交";
        nextErrors.consentAccepted = messageText;
        this.setData({ consentAccepted: false });
        void this.load();
      } else if (requestError.code === "IDEMPOTENCY_KEY_CONFLICT") {
        messageText = "提交内容已变化，请确认后重新提交";
        this.submitFingerprint = "";
        this.submitKey = "";
      } else if (requestError.fields) {
        nextErrors = { ...nextErrors, ...requestError.fields };
      }
      this.setData({ submitError: messageText, fieldErrors: nextErrors });
      wx.showToast({ title: messageText, icon: "none", duration: 2800 });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
