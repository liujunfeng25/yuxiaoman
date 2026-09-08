import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMiniProgramPayParams,
  createEphemeralNotifyFixtures,
  decryptResourceAesGcm,
  encryptNotifyResourceForTest,
  isWechatPayConfigured,
  loadConfig,
  resetWechatPayConfigCache,
  scaleWechatChargeAmountFen,
  signAuthorizationMessage,
  verifyAndDecryptNotify,
} from "../wechat-pay.js";

test("scaleWechatChargeAmountFen divides by WECHAT_PAY_AMOUNT_DIVISOR and rounds to fen", () => {
  const previous = process.env.WECHAT_PAY_AMOUNT_DIVISOR;
  try {
    delete process.env.WECHAT_PAY_AMOUNT_DIVISOR;
    assert.equal(scaleWechatChargeAmountFen(29900), 29900);

    process.env.WECHAT_PAY_AMOUNT_DIVISOR = "1000";
    // ¥299.00 → 29.9 分 → 30 分 = ¥0.30
    assert.equal(scaleWechatChargeAmountFen(29900), 30);
    // ¥1.00 → 0.1 分 → 最少 1 分
    assert.equal(scaleWechatChargeAmountFen(100), 1);
    assert.equal(scaleWechatChargeAmountFen(0), 0);
    assert.equal(scaleWechatChargeAmountFen(1000), 1);
    assert.equal(scaleWechatChargeAmountFen(1500), 2);
  } finally {
    if (previous === undefined) delete process.env.WECHAT_PAY_AMOUNT_DIVISOR;
    else process.env.WECHAT_PAY_AMOUNT_DIVISOR = previous;
  }
});

test("wechat-pay RSA-SHA256 authorization and mini-program paySign with ephemeral key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const message = "POST\n/v3/pay/transactions/jsapi\n1710000000\nnonce123\n{\"foo\":1}\n";
  const signature = signAuthorizationMessage(message, privateKey);
  assert.ok(signature.length > 80);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(message, "utf8");
  verifier.end();
  assert.equal(verifier.verify(publicKey, signature, "base64"), true);

  const params = buildMiniProgramPayParams("wx-prepay-test-001", "wx-test-app", privateKey);
  assert.equal(params.signType, "RSA");
  assert.equal(params.package, "prepay_id=wx-prepay-test-001");
  assert.match(params.timeStamp, /^\d+$/);
  assert.ok(params.nonceStr.length >= 8);
  assert.ok(params.paySign.length > 80);
});

test("wechat-pay AES-GCM decrypt round-trip for notify resource", () => {
  const apiV3Key = "1234567890abcdef1234567890abcdef";
  const plaintext = JSON.stringify({ out_trade_no: "abc", trade_state: "SUCCESS", amount: { total: 100 } });
  const resource = encryptNotifyResourceForTest(apiV3Key, plaintext);
  const decrypted = decryptResourceAesGcm(apiV3Key, resource);
  assert.equal(decrypted, plaintext);
});

test("wechat-pay loadConfig and verifyAndDecryptNotify with ephemeral keys", async () => {
  resetWechatPayConfigCache();
  const previous = {
    WECHAT_PAY_MCH_ID: process.env.WECHAT_PAY_MCH_ID,
    WECHAT_PAY_API_V3_KEY: process.env.WECHAT_PAY_API_V3_KEY,
    WECHAT_PAY_CERT_SERIAL: process.env.WECHAT_PAY_CERT_SERIAL,
    WECHAT_PAY_PRIVATE_KEY_PATH: process.env.WECHAT_PAY_PRIVATE_KEY_PATH,
    WECHAT_PAY_NOTIFY_URL: process.env.WECHAT_PAY_NOTIFY_URL,
    WECHAT_PAY_PUBLIC_KEY_ID: process.env.WECHAT_PAY_PUBLIC_KEY_ID,
    WECHAT_PAY_PUBLIC_KEY_PATH: process.env.WECHAT_PAY_PUBLIC_KEY_PATH,
  };
  try {
    for (const key of Object.keys(previous)) delete process.env[key];
    resetWechatPayConfigCache();
    assert.equal(isWechatPayConfigured(), false);

    const dir = mkdtempSync(join(tmpdir(), "yxm-wechat-pay-"));
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const keyPath = join(dir, "apiclient_key.pem");
    const pubPath = join(dir, "pub.pem");
    writeFileSync(keyPath, privateKey);
    writeFileSync(pubPath, publicKey);
    process.env.WECHAT_PAY_MCH_ID = "1900000000";
    process.env.WECHAT_PAY_API_V3_KEY = "1234567890abcdef1234567890abcdef";
    process.env.WECHAT_PAY_CERT_SERIAL = "ABC123";
    process.env.WECHAT_PAY_PRIVATE_KEY_PATH = keyPath;
    process.env.WECHAT_PAY_NOTIFY_URL = "https://example.com/api/payments/wechat/notify";
    process.env.WECHAT_PAY_PUBLIC_KEY_ID = "PUB_KEY_ID_TEST";
    process.env.WECHAT_PAY_PUBLIC_KEY_PATH = pubPath;
    resetWechatPayConfigCache();
    const config = loadConfig();
    assert.ok(config);
    assert.equal(config?.mchId, "1900000000");

    const plaintext = JSON.stringify({
      out_trade_no: "out1234567890123456789012345678",
      transaction_id: "tx-1",
      trade_state: "SUCCESS",
      amount: { total: 199 },
      attach: "booking:b1",
    });
    const resource = encryptNotifyResourceForTest(config!.apiV3Key, plaintext);
    const envelope = JSON.stringify({
      id: "n1",
      create_time: new Date().toISOString(),
      resource_type: "encrypt-resource",
      event_type: "TRANSACTION.SUCCESS",
      resource,
    });
    const fixtures = createEphemeralNotifyFixtures(envelope);
    process.env.WECHAT_PAY_PUBLIC_KEY_ID = fixtures.serial;
    writeFileSync(pubPath, fixtures.publicKeyPem);
    resetWechatPayConfigCache();
    const notified = await verifyAndDecryptNotify(fixtures.headers, envelope);
    assert.equal(notified.outTradeNo, "out1234567890123456789012345678");
    assert.equal(notified.tradeState, "SUCCESS");
    assert.equal(notified.amountFen, 199);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetWechatPayConfigCache();
  }
});
