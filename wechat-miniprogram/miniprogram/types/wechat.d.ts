type Dictionary = Record<string, unknown>;

declare namespace WechatMiniprogram {
  interface CustomEvent<T = Dictionary> {
    detail: T;
  }
  interface Input {
    detail: { value: string };
  }
}

type PageInstance<D extends Dictionary> = {
  data: D;
  setData(data: Partial<D>, callback?: () => void): void;
  selectComponent(selector: string): unknown;
  [key: string]: any;
};

type PageOptions<D extends Dictionary> = {
  data: D;
  onLoad?(query: Record<string, string>): void | Promise<void>;
  onShow?(): void | Promise<void>;
  onPullDownRefresh?(): void | Promise<void>;
  [key: string]: unknown;
};

declare function App<T>(options: { globalData: T; onLaunch?(): void }): void;
declare function getApp<T>(): { globalData: T };
declare function Page<D extends Dictionary>(options: PageOptions<D> & ThisType<PageInstance<D>>): void;

declare const wx: {
  getUserProfile(options: {
    desc: string;
    success(result: { userInfo?: { nickName?: string; avatarUrl?: string } }): void;
    fail(error: { errMsg?: string }): void;
  }): void;
  login(options: {
    timeout?: number;
    success(result: { code: string }): void;
    fail(error: { errMsg?: string }): void;
  }): void;
  request<T>(options: {
    url: string;
    method?: string;
    data?: unknown;
    header?: Record<string, string>;
    timeout?: number;
    success(result: { statusCode: number; data: T }): void;
    fail(error: { errMsg?: string }): void;
  }): void;
  uploadFile(options: {
    url: string;
    filePath: string;
    name: string;
    formData?: Record<string, string>;
    header?: Record<string, string>;
    timeout?: number;
    success(result: { statusCode: number; data: string }): void;
    fail(error: { errMsg?: string }): void;
  }): void;
  downloadFile(options: {
    url: string;
    header?: Record<string, string>;
    timeout?: number;
    success(result: { statusCode: number; tempFilePath: string; filePath?: string }): void;
    fail(error: { errMsg?: string }): void;
  }): void;
  saveFile(options: {
    tempFilePath: string;
    success(result: { savedFilePath: string }): void;
    fail(error: { errMsg?: string }): void;
  }): void;
  getFileSystemManager(): {
    access(options: { path: string; success(): void; fail(error: { errMsg?: string }): void }): void;
  };
  chooseMedia(options: { count: number; mediaType: string[]; sourceType: string[]; success(result: { tempFiles: Array<{ tempFilePath: string; size: number; fileType: string }> }): void; fail?(error: { errMsg?: string }): void }): void;
  previewImage(options: { current: string; urls: string[] }): void;
  getLocation(options: { type: "gcj02"; success(result: { latitude: number; longitude: number }): void; fail?(error: { errMsg?: string }): void }): void;
  chooseLocation(options: { success(result: { name: string; address: string; latitude: number; longitude: number }): void; fail?(error: { errMsg?: string }): void }): void;
  openLocation(options: { latitude: number; longitude: number; name?: string; address?: string; scale?: number }): void;
  navigateTo(options: { url: string }): void;
  switchTab(options: { url: string }): void;
  redirectTo(options: { url: string }): void;
  navigateBack(options?: { delta?: number }): void;
  reLaunch(options: { url: string }): void;
  showToast(options: { title: string; icon?: "success" | "error" | "none" | "loading"; duration?: number }): void;
  hideToast(): void;
  showModal(options: { title: string; content: string; confirmText?: string; cancelText?: string; confirmColor?: string; success(result: { confirm: boolean; cancel: boolean }): void }): void;
  openSetting(options?: { success?(result: { authSetting: Record<string, boolean> }): void }): void;
  showActionSheet(options: { itemList: string[]; success(result: { tapIndex: number }): void; fail?(error: { errMsg?: string }): void }): void;
  setClipboardData(options: { data: string; success?(): void; fail?(error: { errMsg?: string }): void }): void;
  makePhoneCall(options: { phoneNumber: string; fail?(error: { errMsg?: string }): void }): void;
  showLoading(options: { title: string; mask?: boolean }): void;
  hideLoading(): void;
  stopPullDownRefresh(): void;
  setNavigationBarTitle(options: { title: string }): void;
  setStorageSync(key: string, data: unknown): void;
  getStorageSync<T>(key: string): T;
  removeStorageSync(key: string): void;
  getSystemInfoSync(): { platform: string };
  getAccountInfoSync(): { miniProgram: { envVersion: "develop" | "trial" | "release" } };
};
