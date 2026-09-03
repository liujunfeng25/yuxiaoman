export type WechatProfilePayload = {
  nickName: string;
  avatarUrl: string;
};

export function canUseGetUserProfile(): boolean {
  return typeof wx.getUserProfile === "function";
}

export function isPlaceholderWechatProfile(profile: WechatProfilePayload): boolean {
  const nickName = profile.nickName.trim();
  const avatarUrl = profile.avatarUrl.trim();
  return !nickName || nickName === "微信用户" || !avatarUrl;
}

export function requestWechatProfile(): Promise<WechatProfilePayload> {
  return new Promise((resolve, reject) => {
    if (!canUseGetUserProfile()) {
      reject(new Error("当前微信版本不支持一键授权资料"));
      return;
    }
    wx.getUserProfile({
      desc: "用于客服识别您的订单与服务",
      success: (result) => {
        resolve({
          nickName: String(result.userInfo?.nickName || "").trim(),
          avatarUrl: String(result.userInfo?.avatarUrl || "").trim(),
        });
      },
      fail: (error) => reject(new Error(error.errMsg || "未授权微信资料")),
    });
  });
}
