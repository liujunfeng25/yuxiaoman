import { storeRole } from "../../../../services/storage";
import type { AppRole } from "../../../../types";
import {
  isDemoRepairOperatorSubject,
  loginRepairOperator,
  logoutRepairOperator,
  markRepairOperatorLoginPageReady,
  readRepairOperatorSession,
  refreshRepairOperatorSession,
} from "../../services/operator-session";

type Data = {
  loginName: string;
  password: string;
  submitting: boolean;
  checking: boolean;
  error: string;
  redirect: string;
  signedInName: string;
  shopName: string;
  isDemoShop: boolean;
};

function safeRedirect(value: string): string {
  let decoded = "";
  try { decoded = decodeURIComponent(value || ""); } catch { decoded = value || ""; }
  return /^\/packages\/repair\/pages\/(?:shop-hall|shop-request-detail|shop-quote|shop-deal)\//u.test(decoded)
    ? decoded
    : "/packages/repair/pages/shop-hall/shop-hall";
}

Page<Data>({
  data: {
    loginName: "",
    password: "",
    submitting: false,
    checking: true,
    error: "",
    redirect: "/packages/repair/pages/shop-hall/shop-hall",
    signedInName: "",
    shopName: "",
    isDemoShop: false,
  },

  async onLoad(query) {
    markRepairOperatorLoginPageReady();
    const redirect = safeRedirect(query.redirect || "");
    this.setData({ redirect });
    const session = readRepairOperatorSession();
    if (!session) { this.setData({ checking: false }); return; }
    this.applySession(session);
    try {
      this.applySession(await refreshRepairOperatorSession());
    } catch {
      this.setData({ signedInName: "", shopName: "", isDemoShop: false });
    } finally {
      this.setData({ checking: false });
    }
  },

  applySession(session) {
    this.setData({
      signedInName: session.account.displayName,
      shopName: session.subject.name,
      isDemoShop: isDemoRepairOperatorSubject(session.subject),
    });
  },

  inputLoginName(event) { this.setData({ loginName: String(event.detail.value || ""), error: "" }); },
  inputPassword(event) { this.setData({ password: String(event.detail.value || ""), error: "" }); },

  async submit() {
    const loginName = this.data.loginName.trim();
    if (!loginName || !this.data.password || this.data.submitting) {
      if (!loginName || !this.data.password) this.setData({ error: "请输入登录名和密码" });
      return;
    }
    this.setData({ submitting: true, error: "" });
    try {
      await loginRepairOperator(loginName, this.data.password);
      this.enterRepairRole();
      wx.redirectTo({ url: this.data.redirect });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "登录失败，请稍后重试" });
    } finally {
      this.setData({ submitting: false });
    }
  },

  enterRepairRole() {
    storeRole("repair_shop");
    getApp<{ role: AppRole }>().globalData.role = "repair_shop";
  },

  enterSignedIn() {
    this.enterRepairRole();
    wx.redirectTo({ url: this.data.redirect });
  },

  async changeAccount() {
    await logoutRepairOperator().catch(() => undefined);
    storeRole("consumer");
    getApp<{ role: AppRole }>().globalData.role = "consumer";
    this.setData({ signedInName: "", shopName: "", isDemoShop: false, password: "", error: "" });
  },

  backOwner() {
    storeRole("consumer");
    getApp<{ role: AppRole }>().globalData.role = "consumer";
    wx.switchTab({ url: "/pages/profile/profile" });
  },
});
