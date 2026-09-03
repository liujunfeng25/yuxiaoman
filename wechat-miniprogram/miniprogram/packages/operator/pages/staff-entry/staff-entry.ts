Page({
  data: {},

  enterStation() {
    wx.navigateTo({ url: "/packages/operator/pages/operator-login/operator-login" });
  },

  enterRepair() {
    wx.navigateTo({ url: "/packages/repair/pages/shop-login/shop-login" });
  },

  enterDriver() {
    wx.navigateTo({ url: "/packages/driver/pages/login/login" });
  },

  backOwner() {
    wx.switchTab({ url: "/pages/profile/profile" });
  },
});
