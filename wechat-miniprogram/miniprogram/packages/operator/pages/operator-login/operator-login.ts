import {
  loginOperator,
  logoutOperator,
  markOperatorLoginPageReady,
  readOperatorSession,
  refreshOperatorSession,
} from "../../../../services/operator-session";
import { storeRole } from "../../../../services/storage";
import type { AppRole } from "../../../../types";

type Data = {
  loginName: string;
  password: string;
  submitting: boolean;
  checking: boolean;
  error: string;
  redirect: string;
  signedInName: string;
  stationName: string;
};

function safeRedirect(value: string): string {
  let decoded = "";
  try { decoded = decodeURIComponent(value || ""); } catch { decoded = value || ""; }
  return decoded.startsWith("/packages/operator/") || decoded.startsWith("/packages/inspection/")
    ? decoded
    : "/packages/operator/pages/operator/operator";
}

Page<Data>({
  data: {
    loginName: "",
    password: "",
    submitting: false,
    checking: true,
    error: "",
    redirect: "/packages/operator/pages/operator/operator",
    signedInName: "",
    stationName: "",
  },

  async onLoad(query) {
    markOperatorLoginPageReady();
    const redirect = safeRedirect(query.redirect || "");
    this.setData({ redirect });
    const session = readOperatorSession();
    if (!session) { this.setData({ checking: false }); return; }
    this.setData({ signedInName: session.account.displayName, stationName: session.subject?.name || "平台检测工作台" });
    try {
      const refreshed = await refreshOperatorSession();
      this.setData({ signedInName: refreshed.account.displayName, stationName: refreshed.subject?.name || "平台检测工作台" });
    } catch {
      this.setData({ signedInName: "", stationName: "" });
    } finally {
      this.setData({ checking: false });
    }
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
      await loginOperator(loginName, this.data.password);
      storeRole("operator");
      getApp<{ role: AppRole }>().globalData.role = "operator";
      wx.redirectTo({ url: this.data.redirect });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "登录失败，请稍后重试" });
    } finally {
      this.setData({ submitting: false });
    }
  },

  enterSignedIn() { wx.redirectTo({ url: this.data.redirect }); },
  async changeAccount() {
    await logoutOperator().catch(() => undefined);
    this.setData({ signedInName: "", stationName: "", password: "", error: "" });
  },
  backOwner() { wx.switchTab({ url: "/pages/profile/profile" }); },
});
