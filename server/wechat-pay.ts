import {
  createCipheriv,
  createDecipheriv,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFileSync } from "node:fs";

const WECHAT_PAY_HOST = "https://api.mch.weixin.qq.com";
const PLATFORM_CERT_CACHE_TTL_MS = 60 * 60 * 1000;

export type WechatPayConfig = {
  mchId: string;
  apiV3Key: string;
  certSerial: string;
  privateKeyPem: string;
  notifyUrl: string;
  publicKeyId?: string;
  publicKeyPem?: string;
};

export type JsapiPrepayInput = {
  appId: string;
  openid: string;
  outTradeNo: string;
  description: string;
  amountFen: number;
  notifyUrl: string;
  attach?: string;
};

export type MiniProgramPayParams = {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
};

export type WechatNotifyResult = {
  outTradeNo: string;
  transactionId: string;
  tradeState: string;
  amountFen: number;
  attach: string | null;
  successTime: string | null;
  raw: Record<string, unknown>;
};

type PlatformCertEntry = {
  serialNo: string;
  publicKeyPem: string;
};

let cachedConfig: WechatPayConfig | null | undefined;
let platformCertCache: { fetchedAt: number; certs: PlatformCertEntry[] } | null = null;

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function readOptionalFile(pathValue: string): string | undefined {
  if (!pathValue) return undefined;
  try {
    return readFileSync(pathValue, "utf8");
  } catch {
    return undefined;
  }
}

/** Load merchant WeChat Pay APIv3 settings from process env. */
export function loadConfig(): WechatPayConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const mchId = trimEnv("WECHAT_PAY_MCH_ID");
  const apiV3Key = trimEnv("WECHAT_PAY_API_V3_KEY");
  const certSerial = trimEnv("WECHAT_PAY_CERT_SERIAL");
  const privateKeyPath = trimEnv("WECHAT_PAY_PRIVATE_KEY_PATH");
  const notifyUrl = trimEnv("WECHAT_PAY_NOTIFY_URL");
  const publicKeyId = trimEnv("WECHAT_PAY_PUBLIC_KEY_ID") || undefined;
  const publicKeyPath = trimEnv("WECHAT_PAY_PUBLIC_KEY_PATH");
  if (!mchId || !apiV3Key || !certSerial || !privateKeyPath || !notifyUrl) {
    cachedConfig = null;
    return null;
  }
  if (apiV3Key.length !== 32) {
    cachedConfig = null;
    return null;
  }
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(privateKeyPath, "utf8");
  } catch {
    cachedConfig = null;
    return null;
  }
  if (!privateKeyPem.includes("PRIVATE KEY")) {
    cachedConfig = null;
    return null;
  }
  const publicKeyPem = readOptionalFile(publicKeyPath ?? "");
  const usablePublicKey = publicKeyPem
    && (publicKeyPem.includes("PUBLIC KEY") || publicKeyPem.includes("CERTIFICATE"))
    ? publicKeyPem
    : undefined;
  cachedConfig = {
    mchId,
    apiV3Key,
    certSerial,
    privateKeyPem,
    notifyUrl,
    publicKeyId,
    publicKeyPem: usablePublicKey,
  };
  return cachedConfig;
}

/** Reset cached config (tests). */
export function resetWechatPayConfigCache(): void {
  cachedConfig = undefined;
  platformCertCache = null;
}

export function isWechatPayConfigured(): boolean {
  return loadConfig() != null;
}

export function recommendedPaymentProvider(): "wechat" | "mock" {
  return isWechatPayConfigured() ? "wechat" : "mock";
}

function nonceStr(size = 32): string {
  return randomBytes(Math.ceil(size / 2)).toString("hex").slice(0, size);
}

function authorizationMessage(
  method: string,
  urlPath: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
}

export function signAuthorizationMessage(message: string, privateKeyPem: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(message, "utf8");
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

function buildAuthorizationHeader(
  config: WechatPayConfig,
  method: string,
  urlPath: string,
  body: string,
): string {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = nonceStr(32);
  const message = authorizationMessage(method, urlPath, timestamp, nonce, body);
  const signature = signAuthorizationMessage(message, config.privateKeyPem);
  return [
    `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}"`,
    `nonce_str="${nonce}"`,
    `signature="${signature}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${config.certSerial}"`,
  ].join(",");
}

async function wechatApiRequest(
  config: WechatPayConfig,
  method: "GET" | "POST",
  urlPath: string,
  bodyObject?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const body = bodyObject == null ? "" : JSON.stringify(bodyObject);
  const authorization = buildAuthorizationHeader(config, method, urlPath, body);
  const response = await fetch(`${WECHAT_PAY_HOST}${urlPath}`, {
    method,
    headers: {
      Authorization: authorization,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "yuxiaoman-wechat-pay/1.0",
    },
    body: method === "GET" ? undefined : body,
  });
  const responseBody = await response.text();
  let json: Record<string, unknown> | null = null;
  if (responseBody.trim()) {
    try {
      json = JSON.parse(responseBody) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return { status: response.status, json };
}

export function buildMiniProgramPayParams(
  prepayId: string,
  appId: string,
  privateKeyPem?: string,
): MiniProgramPayParams {
  const config = privateKeyPem ? null : loadConfig();
  const key = privateKeyPem ?? config?.privateKeyPem;
  if (!key) throw new Error("WeChat Pay private key is not configured");
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonce = nonceStr(32);
  const packageValue = `prepay_id=${prepayId}`;
  const message = `${appId}\n${timeStamp}\n${nonce}\n${packageValue}\n`;
  return {
    timeStamp,
    nonceStr: nonce,
    package: packageValue,
    signType: "RSA",
    paySign: signAuthorizationMessage(message, key),
  };
}

export async function createJsapiPrepay(input: JsapiPrepayInput): Promise<{ prepayId: string }> {
  const config = loadConfig();
  if (!config) throw new Error("WeChat Pay is not configured");
  if (!Number.isInteger(input.amountFen) || input.amountFen <= 0) {
    throw new Error("amountFen must be a positive integer");
  }
  const payload: Record<string, unknown> = {
    appid: input.appId,
    mchid: config.mchId,
    description: input.description.slice(0, 127),
    out_trade_no: input.outTradeNo,
    notify_url: input.notifyUrl || config.notifyUrl,
    amount: { total: input.amountFen, currency: "CNY" },
    payer: { openid: input.openid },
  };
  if (input.attach) payload.attach = input.attach.slice(0, 128);
  const result = await wechatApiRequest(config, "POST", "/v3/pay/transactions/jsapi", payload);
  const prepayId = typeof result.json?.prepay_id === "string" ? result.json.prepay_id : "";
  if (result.status >= 300 || !prepayId) {
    const code = typeof result.json?.code === "string" ? result.json.code : "WECHAT_PREPAY_FAILED";
    const message = typeof result.json?.message === "string"
      ? result.json.message
      : "微信统一下单失败";
    const error = new Error(message) as Error & { code?: string; status?: number; detail?: unknown };
    error.code = code;
    error.status = result.status;
    error.detail = result.json;
    throw error;
  }
  return { prepayId };
}

export function decryptResourceAesGcm(
  apiV3Key: string,
  resource: { ciphertext: string; nonce: string; associated_data?: string | null },
): string {
  const buf = Buffer.from(resource.ciphertext, "base64");
  if (buf.length <= 16) throw new Error("Invalid WeChat Pay ciphertext");
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key, "utf8"),
    Buffer.from(resource.nonce, "utf8"),
  );
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, "utf8"));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function verifyRsaSha256(publicKeyPem: string, message: string, signatureBase64: string): boolean {
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(message, "utf8");
    verifier.end();
    return verifier.verify(publicKeyPem, signatureBase64, "base64");
  } catch {
    return false;
  }
}

async function fetchPlatformCertificates(config: WechatPayConfig): Promise<PlatformCertEntry[]> {
  const now = Date.now();
  if (platformCertCache && now - platformCertCache.fetchedAt < PLATFORM_CERT_CACHE_TTL_MS) {
    return platformCertCache.certs;
  }
  const result = await wechatApiRequest(config, "GET", "/v3/certificates");
  const data = Array.isArray(result.json?.data) ? result.json.data as Array<Record<string, unknown>> : [];
  const certs: PlatformCertEntry[] = [];
  for (const item of data) {
    const serialNo = typeof item.serial_no === "string" ? item.serial_no : "";
    const encryptCertificate = item.encrypt_certificate as Record<string, unknown> | undefined;
    if (!serialNo || !encryptCertificate) continue;
    const ciphertext = typeof encryptCertificate.ciphertext === "string" ? encryptCertificate.ciphertext : "";
    const nonce = typeof encryptCertificate.nonce === "string" ? encryptCertificate.nonce : "";
    const associatedData = typeof encryptCertificate.associated_data === "string"
      ? encryptCertificate.associated_data
      : "certificate";
    if (!ciphertext || !nonce) continue;
    try {
      const pem = decryptResourceAesGcm(config.apiV3Key, {
        ciphertext,
        nonce,
        associated_data: associatedData,
      });
      certs.push({ serialNo, publicKeyPem: pem });
    } catch {
      // Skip undecryptable entries; verification fails closed if none match.
    }
  }
  platformCertCache = { fetchedAt: now, certs };
  return certs;
}

async function resolveNotifyVerifyKey(
  config: WechatPayConfig,
  wechatpaySerial: string,
): Promise<string | null> {
  if (config.publicKeyPem && config.publicKeyId && config.publicKeyId === wechatpaySerial) {
    return config.publicKeyPem;
  }
  if (wechatpaySerial.startsWith("PUB_KEY_ID_")) {
    // Public-key mode requires the WeChat Pay public key PEM from the merchant console.
    return config.publicKeyPem && (!config.publicKeyId || config.publicKeyId === wechatpaySerial)
      ? config.publicKeyPem
      : null;
  }
  const certs = await fetchPlatformCertificates(config);
  return certs.find((cert) => cert.serialNo === wechatpaySerial)?.publicKeyPem ?? null;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] ?? "");
  return typeof direct === "string" ? direct : "";
}

export async function verifyAndDecryptNotify(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): Promise<WechatNotifyResult> {
  const config = loadConfig();
  if (!config) throw new Error("WeChat Pay is not configured");
  const timestamp = headerValue(headers, "Wechatpay-Timestamp");
  const nonce = headerValue(headers, "Wechatpay-Nonce");
  const signature = headerValue(headers, "Wechatpay-Signature");
  const serial = headerValue(headers, "Wechatpay-Serial");
  if (!timestamp || !nonce || !signature || !serial || !rawBody) {
    throw new Error("Missing WeChat Pay notify signature headers or body");
  }
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(skewSeconds) || skewSeconds > 300) {
    throw new Error("WeChat Pay notify timestamp is outside the allowed window");
  }
  const publicKeyPem = await resolveNotifyVerifyKey(config, serial);
  if (!publicKeyPem) {
    const hint = serial.startsWith("PUB_KEY_ID_")
      ? "Configure WECHAT_PAY_PUBLIC_KEY_PATH (and WECHAT_PAY_PUBLIC_KEY_ID) with the WeChat Pay public key PEM from the merchant console."
      : "Unable to load a platform certificate matching Wechatpay-Serial; check merchant credentials or retry.";
    const error = new Error(`WeChat Pay notify signature key unavailable. ${hint}`) as Error & {
      code?: string;
    };
    error.code = "WECHAT_NOTIFY_VERIFY_KEY_MISSING";
    throw error;
  }
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  if (!verifyRsaSha256(publicKeyPem, message, signature)) {
    throw new Error("WeChat Pay notify signature verification failed");
  }
  const envelope = JSON.parse(rawBody) as {
    resource?: { ciphertext?: string; nonce?: string; associated_data?: string };
  };
  const resource = envelope.resource;
  if (!resource?.ciphertext || !resource.nonce) {
    throw new Error("WeChat Pay notify resource is missing");
  }
  const plain = decryptResourceAesGcm(config.apiV3Key, {
    ciphertext: resource.ciphertext,
    nonce: resource.nonce,
    associated_data: resource.associated_data ?? "",
  });
  const payload = JSON.parse(plain) as Record<string, unknown>;
  const outTradeNo = typeof payload.out_trade_no === "string" ? payload.out_trade_no : "";
  const transactionId = typeof payload.transaction_id === "string" ? payload.transaction_id : "";
  const tradeState = typeof payload.trade_state === "string" ? payload.trade_state : "";
  const amount = payload.amount as { total?: number } | undefined;
  const amountFen = Number(amount?.total ?? 0);
  if (!outTradeNo || !tradeState) {
    throw new Error("WeChat Pay notify payload is incomplete");
  }
  return {
    outTradeNo,
    transactionId,
    tradeState,
    amountFen,
    attach: typeof payload.attach === "string" ? payload.attach : null,
    successTime: typeof payload.success_time === "string" ? payload.success_time : null,
    raw: payload,
  };
}

/** Test helper: sign a notify body with an ephemeral RSA key pair. */
export function createEphemeralNotifyFixtures(rawBody: string): {
  privateKeyPem: string;
  publicKeyPem: string;
  headers: Record<string, string>;
  serial: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = nonceStr(16);
  const serial = `TEST${randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    serial,
    headers: {
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Signature": signAuthorizationMessage(message, privateKey),
      "Wechatpay-Serial": serial,
    },
  };
}

/** Test helper: AES-GCM encrypt a notify resource with an ASCII nonce. */
export function encryptNotifyResourceForTest(
  apiV3Key: string,
  plaintext: string,
  associatedData = "transaction",
): { algorithm: string; ciphertext: string; nonce: string; associated_data: string } {
  const nonce = randomBytes(12).toString("hex").slice(0, 12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key, "utf8"), Buffer.from(nonce, "utf8"));
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: "AEAD_AES_256_GCM",
    ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
    nonce,
    associated_data: associatedData,
  };
}
