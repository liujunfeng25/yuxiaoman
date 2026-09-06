import { apiBaseUrl, assertApiConfigured } from "../../../config/env";
import { withOwnerAuthorization } from "../../../services/session";
import {
  normalizeDriverSession,
  normalizeDriverTask,
  type DriverEvidencePhoto,
  type DriverEvidencePhotoKind,
  type DriverEvidenceStage,
  type DriverTask,
  type DriverTaskSession,
} from "../model";
import {
  clearDriverTaskSession,
  driverAuthorizationHeaders,
  storeDriverTaskSession,
} from "./driver-session";

type Envelope<T> = {
  data: T;
  error?: { code?: string; message?: string; fields?: Record<string, string> };
};

type DriverApiError = Error & {
  code?: string;
  statusCode?: number;
  fields?: Record<string, string>;
};

export function isDriverSessionAccessError(error: unknown): boolean {
  const statusCode = Number((error as { statusCode?: number } | null)?.statusCode || 0);
  return statusCode === 401 || statusCode === 404;
}

function apiError(payload: unknown, statusCode: number, fallback: string): DriverApiError {
  const envelope = payload && typeof payload === "object" ? payload as Envelope<unknown> : undefined;
  const error = new Error(envelope?.error?.message || fallback) as DriverApiError;
  error.code = envelope?.error?.code;
  error.statusCode = statusCode;
  error.fields = envelope?.error?.fields;
  return error;
}

type DriverExchangePayload =
  | { taskCode: string; driverPhone?: string }
  | { verificationCode: string; driverPhone: string };

function ownerExchange(data: DriverExchangePayload): Promise<unknown> {
  assertApiConfigured();
  return withOwnerAuthorization(
    { "content-type": "application/json" },
    (headers) => new Promise((resolve, reject) => {
      wx.request<Envelope<unknown>>({
        url: `${apiBaseUrl}/driver/task-sessions/exchange`,
        method: "POST",
        data,
        header: headers,
        timeout: 10000,
        success: (result) => {
          if (result.statusCode >= 200 && result.statusCode < 300) {
            resolve(result.data?.data);
            return;
          }
          reject(apiError(result.data, result.statusCode, "无法绑定代驾任务"));
        },
        fail: (error) => reject(new Error(error.errMsg || "无法连接任务服务")),
      });
    }),
  );
}

function driverRequest<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  assertApiConfigured();
  let headers: Record<string, string>;
  try {
    headers = { "content-type": "application/json", ...driverAuthorizationHeaders() };
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    wx.request<Envelope<T>>({
      url: `${apiBaseUrl}${path}`,
      method,
      data,
      header: headers,
      timeout: 10000,
      success: (result) => {
        if (result.statusCode >= 200 && result.statusCode < 300) {
          resolve(result.data?.data);
          return;
        }
        if (result.statusCode === 401) clearDriverTaskSession();
        reject(apiError(result.data, result.statusCode, "代驾任务服务暂时不可用"));
      },
      fail: (error) => reject(new Error(error.errMsg || "无法连接任务服务")),
    });
  });
}

function driverUpload<T>(options: {
  path: string;
  filePath: string;
  formData: Record<string, string>;
}): Promise<T> {
  assertApiConfigured();
  let headers: Record<string, string>;
  try {
    headers = driverAuthorizationHeaders();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${apiBaseUrl}${options.path}`,
      filePath: options.filePath,
      name: "file",
      formData: options.formData,
      header: headers,
      timeout: 30000,
      success: (result) => {
        let payload: Envelope<T> | undefined;
        try { payload = JSON.parse(result.data) as Envelope<T>; } catch { payload = undefined; }
        if (result.statusCode >= 200 && result.statusCode < 300 && payload) {
          resolve(payload.data);
          return;
        }
        if (result.statusCode === 401) clearDriverTaskSession();
        reject(apiError(payload, result.statusCode, "现场照片上传失败"));
      },
      fail: (error) => reject(new Error(error.errMsg || "现场照片上传失败")),
    });
  });
}

function taskPayload(value: unknown): DriverTask {
  if (value && typeof value === "object") {
    const source = value as { task?: unknown; booking?: unknown };
    if (source.task) return normalizeDriverTask(source.task);
  }
  return normalizeDriverTask(value);
}

const evidenceMediaDownloads = new Map<string, Promise<string>>();

function localEvidenceUrl(url: string): Promise<string> {
  if (!/^https?:\/\//iu.test(url)) return Promise.resolve(url);
  const cached = evidenceMediaDownloads.get(url);
  if (cached) return cached;
  let headers: Record<string, string>;
  try {
    headers = driverAuthorizationHeaders();
  } catch (error) {
    return Promise.reject(error);
  }
  const pending = new Promise<string>((resolve, reject) => {
    wx.downloadFile({
      url,
      header: headers,
      timeout: 20000,
      success: (result) => {
        if (result.statusCode >= 200 && result.statusCode < 300 && result.tempFilePath) {
          resolve(result.tempFilePath);
          return;
        }
        if (result.statusCode === 401) clearDriverTaskSession();
        reject(apiError(undefined, result.statusCode, "留证照片读取失败"));
      },
      fail: (error) => reject(new Error(error.errMsg || "留证照片读取失败")),
    });
  });
  evidenceMediaDownloads.set(url, pending);
  pending.catch(() => evidenceMediaDownloads.delete(url));
  return pending;
}

async function localizeTaskEvidence(task: DriverTask): Promise<DriverTask> {
  const evidencePackages = await Promise.all(task.evidencePackages.map(async (evidence) => ({
    ...evidence,
    photos: await Promise.all(evidence.photos.map(async (photo) => ({
      ...photo,
      url: await localEvidenceUrl(photo.url).catch(() => ""),
    }))),
  })));
  return { ...task, evidencePackages };
}

export const driverApi = {
  async exchange(taskCode: string): Promise<DriverTaskSession> {
    const payload = await ownerExchange({ taskCode: taskCode.trim() });
    const session = normalizeDriverSession(payload);
    if (!session) throw new Error("任务入口返回的代驾凭证无效");
    evidenceMediaDownloads.clear();
    storeDriverTaskSession(session);
    return session;
  },

  async exchangeVerificationCode(verificationCode: string, driverPhone: string): Promise<DriverTaskSession> {
    const code = verificationCode.replace(/\D/gu, "").slice(0, 6);
    if (!/^\d{6}$/u.test(code)) throw new Error("请输入后台生成的 6 位验证码");
    const phone = driverPhone.replace(/\D/gu, "").slice(0, 11);
    if (!/^1\d{10}$/u.test(phone)) throw new Error("请输入有效的 11 位手机号");
    const payload = await ownerExchange({ verificationCode: code, driverPhone: phone });
    const session = normalizeDriverSession(payload);
    if (!session) throw new Error("验证码返回的代驾凭证无效");
    evidenceMediaDownloads.clear();
    storeDriverTaskSession(session);
    return session;
  },

  async task(bookingId: string): Promise<DriverTask> {
    return localizeTaskEvidence(taskPayload(await driverRequest<unknown>(`/driver/tasks/${encodeURIComponent(bookingId)}`)));
  },

  async taskSummary(bookingId: string): Promise<DriverTask> {
    return taskPayload(await driverRequest<unknown>(`/driver/tasks/${encodeURIComponent(bookingId)}`));
  },

  async uploadEvidencePhoto(
    bookingId: string,
    stage: DriverEvidenceStage,
    kind: DriverEvidencePhotoKind,
    filePath: string,
  ): Promise<DriverEvidencePhoto> {
    return driverUpload<DriverEvidencePhoto>({
      path: `/driver/tasks/${encodeURIComponent(bookingId)}/evidence/${stage}/media`,
      filePath,
      formData: { kind },
    });
  },

  async deleteEvidencePhoto(
    bookingId: string,
    stage: DriverEvidenceStage,
    mediaId: string,
  ): Promise<void> {
    await driverRequest<unknown>(
      `/driver/tasks/${encodeURIComponent(bookingId)}/evidence/${stage}/media/${encodeURIComponent(mediaId)}`,
      "DELETE",
    );
  },

  async completeEvidence(
    bookingId: string,
    stage: DriverEvidenceStage,
    idempotencyKey: string,
  ): Promise<DriverTask> {
    return localizeTaskEvidence(taskPayload(await driverRequest<unknown>(
      `/driver/tasks/${encodeURIComponent(bookingId)}/evidence/${stage}/complete`,
      "POST",
      { idempotencyKey },
    )));
  },

  async startReturn(bookingId: string, idempotencyKey: string): Promise<DriverTask> {
    return localizeTaskEvidence(taskPayload(await driverRequest<unknown>(
      `/driver/tasks/${encodeURIComponent(bookingId)}/start-return`,
      "POST",
      { idempotencyKey },
    )));
  },
};
