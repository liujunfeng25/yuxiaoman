import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createOwnerMediaLocalizer,
  ownerMediaSourceUrl,
  type OwnerMediaRuntime,
} from "../miniprogram/services/owner-media";
import { localizeOwnerBookingPrivateMedia, localizeOwnerRepairRequestPrivateMedia } from "../miniprogram/services/api";
import { apiOrigin } from "../miniprogram/config/env";
import type { Booking, RepairRequest } from "../miniprogram/types";

function fixture(downloadImpl?: OwnerMediaRuntime["download"]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const authorize: OwnerMediaRuntime["authorize"] = async (operation) => operation({ Authorization: "Bearer owner-token" });
  const download: OwnerMediaRuntime["download"] = async (url, headers) => {
    calls.push({ url, headers });
    if (downloadImpl) return downloadImpl(url, headers);
    return { statusCode: 200, tempFilePath: `wxfile://owner-evidence-${calls.length}.jpg` };
  };
  return { localizer: createOwnerMediaLocalizer({ authorize, download }), calls };
}

test("车主私有留证先携带 Bearer 下载，再只返回本地临时路径", async () => {
  const { localizer, calls } = fixture();
  const result = await localizer.localize("/api/bookings/booking-1/evidence-media/media-1");

  assert.equal(result, "wxfile://owner-evidence-1.jpg");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.headers.Authorization, "Bearer owner-token");
  assert.equal(calls[0]?.url, ownerMediaSourceUrl("/api/bookings/booking-1/evidence-media/media-1"));
  assert.notEqual(result, calls[0]?.url);
});

test("并发与重复读取共用缓存，显式刷新才重新安全下载", async () => {
  const { localizer, calls } = fixture();
  const source = "https://media.example.test/private/evidence-1";
  const [first, second] = await Promise.all([localizer.localize(source), localizer.localize(source)]);

  assert.equal(first, "wxfile://owner-evidence-1.jpg");
  assert.equal(second, first);
  assert.equal(calls.length, 1);
  assert.equal(await localizer.localize(source), first);
  assert.equal(calls.length, 1);

  assert.equal(await localizer.localize(source, { forceRefresh: true }), "wxfile://owner-evidence-2.jpg");
  assert.equal(calls.length, 2);
});

test("私有照片优先固化到本地，缓存文件失效后自动驱逐并重下", async () => {
  let exists = true;
  let downloads = 0;
  const localizer = createOwnerMediaLocalizer({
    authorize: async (operation) => operation({ Authorization: "Bearer owner-token" }),
    download: async () => ({ statusCode: 200, tempFilePath: `wxfile://temp-${++downloads}.jpg` }),
    persist: async (path) => path.replace("temp-", "saved-"),
    exists: async () => exists,
  });
  const source = "/api/media/persistent-owner-photo";

  assert.equal(await localizer.localize(source), "wxfile://saved-1.jpg");
  assert.equal(await localizer.localize(source), "wxfile://saved-1.jpg");
  assert.equal(downloads, 1);

  exists = false;
  assert.equal(await localizer.localize(source), "wxfile://saved-2.jpg");
  assert.equal(downloads, 2);
});

test("历史 localhost 私有地址改写到当前 API origin", () => {
  const rewritten = ownerMediaSourceUrl("http://127.0.0.1:8000/api/media/legacy-photo?size=large");
  assert.equal(rewritten, `${apiOrigin}/api/media/legacy-photo?size=large`);
  assert.doesNotMatch(rewritten, /:8000/u);
});

test("安全下载失败不会回退裸受保护 URL，并会清缓存允许重试", async () => {
  let attempt = 0;
  const { localizer, calls } = fixture(async () => {
    attempt += 1;
    return attempt === 1
      ? { statusCode: 503, tempFilePath: "" }
      : { statusCode: 200, tempFilePath: "wxfile://owner-evidence-retried.jpg" };
  });
  const source = "https://media.example.test/private/evidence-2";

  await assert.rejects(localizer.localize(source), /安全读取失败/u);
  assert.equal(calls.length, 1);
  assert.equal(await localizer.localize(source), "wxfile://owner-evidence-retried.jpg");
  assert.equal(calls.length, 2);
});

test("本地资源无需下载，订单留证只将本地化结果交给 image，并提供失败重试", async () => {
  const { localizer, calls } = fixture();
  assert.equal(await localizer.localize("/assets/icons/camera.png"), "/assets/icons/camera.png");
  assert.equal(calls.length, 0);

  const pageSource = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.ts", import.meta.url), "utf8");
  const templateSource = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.wxml", import.meta.url), "utf8");
  assert.match(pageSource, /localizeOwnerMedia\(photo\.sourceUrl/u);
  assert.match(templateSource, /bindtap="retryEvidencePhoto"/u);
  assert.match(templateSource, /src="\{\{photo\.url\}\}"/u);
  assert.doesNotMatch(templateSource, /src="\{\{photo\.sourceUrl\}\}"/u);
});

test("订单预约资料与体检报告统一本地化，失败媒体不回退裸私有 URL", async () => {
  const booking = {
    id: "booking-private-media",
    media: [{
      id: "booking-photo",
      kind: "license_front",
      mimeType: "image/jpeg",
      sizeBytes: 100,
      width: 10,
      height: 10,
      url: "/api/media/booking-photo",
      createdAt: "2026-08-27T00:00:00.000Z",
    }],
    vehicleCheckupReport: {
      diagramVersion: "sedan-3view-v1",
      observationMode: "faults_recorded",
      annualInspection: { conclusion: "passed", markPhoto: null },
      sitePhotos: {
        frontLeft: { id: "site-ok", kind: "front_left", url: "/api/bookings/booking-private-media/checkup-report/media/site-ok" },
        frontRight: { id: "site-failed", kind: "front_right", url: "/api/bookings/booking-private-media/checkup-report/media/site-failed" },
      },
      legalMaterials: {
        safetyInspectionReport: { id: "legal-ok", kind: "safety_inspection_report", url: "/api/bookings/booking-private-media/checkup-report/media/legal-ok" },
      },
      faults: [{
        id: "fault-1",
        viewId: "left",
        regionCode: "left_front_door",
        faultType: "scratch",
        severity: "minor",
        photos: [{ id: "fault-failed", kind: "fault_closeup", url: "/api/bookings/booking-private-media/checkup-report/media/fault-failed" }],
      }],
      media: [
        { id: "site-ok", kind: "front_left", url: "/api/bookings/booking-private-media/checkup-report/media/site-ok" },
        { id: "site-failed", kind: "front_right", url: "/api/bookings/booking-private-media/checkup-report/media/site-failed" },
        { id: "legal-ok", kind: "safety_inspection_report", url: "/api/bookings/booking-private-media/checkup-report/media/legal-ok" },
      ],
    },
  } as unknown as Booking;
  const calls: string[] = [];
  const localized = await localizeOwnerBookingPrivateMedia(booking, async (path) => {
    calls.push(path);
    if (path.includes("failed")) throw new Error("synthetic protected media failure");
    return `wxfile://localized/${path.split("/").at(-1)}`;
  });

  assert.equal(localized.media?.[0]?.url, "wxfile://localized/booking-photo");
  assert.equal(localized.media?.[0]?.sourceUrl, "/api/media/booking-photo");
  assert.equal(localized.media?.[0]?.loadState, "ready");
  assert.equal(localized.vehicleCheckupReport?.sitePhotos?.frontLeft?.url, "wxfile://localized/site-ok");
  assert.equal(localized.vehicleCheckupReport?.sitePhotos?.frontRight?.url, "");
  assert.equal(localized.vehicleCheckupReport?.sitePhotos?.frontRight?.loadState, "failed");
  assert.match(localized.vehicleCheckupReport?.sitePhotos?.frontRight?.sourceUrl || "", /site-failed$/u);
  assert.equal(localized.vehicleCheckupReport?.faults[0]?.photos?.[0]?.url, "");
  assert.equal(localized.vehicleCheckupReport?.legalMaterials?.safetyInspectionReport?.url, "wxfile://localized/legal-ok");
  assert.ok(calls.some((path) => path === "/api/media/booking-photo"));

  const renderedUrls = [
    ...(localized.media || []),
    ...(localized.vehicleCheckupReport?.media || []),
    ...(localized.vehicleCheckupReport?.faults.flatMap((fault) => fault.photos || []) || []),
  ].map((item) => item.url).filter(Boolean);
  assert.equal(renderedUrls.some((url) => url.startsWith("/api/")), false);
});

test("维修需求车损照片同样经车主 Bearer 本地化，失败时不渲染裸 URL", async () => {
  const request = {
    id: "repair-1",
    faults: [{
      id: "fault-1",
      photos: [
        { id: "repair-ok", url: "http://localhost:8000/api/repair/requests/repair-1/media/repair-ok" },
        { id: "repair-failed", url: "/api/repair/requests/repair-1/media/repair-failed" },
      ],
    }],
    media: [
      { id: "repair-ok", url: "http://localhost:8000/api/repair/requests/repair-1/media/repair-ok" },
      { id: "repair-failed", url: "/api/repair/requests/repair-1/media/repair-failed" },
    ],
    quotes: [],
  } as unknown as RepairRequest;
  const seen: string[] = [];
  const localized = await localizeOwnerRepairRequestPrivateMedia(request, async (path) => {
    seen.push(path);
    if (path.includes("failed")) throw new Error("synthetic failure");
    return "wxfile://saved-repair-ok.jpg";
  });

  assert.equal(localized.media[0]?.url, "wxfile://saved-repair-ok.jpg");
  assert.equal(localized.media[1]?.url, "");
  assert.equal(localized.media[1]?.loadState, "failed");
  assert.equal(localized.faults[0]?.photos[0]?.url, "wxfile://saved-repair-ok.jpg");
  assert.equal(localized.faults[0]?.photos[1]?.url, "");
  assert.ok(seen.every((url) => !url.includes("localhost:8000")));
});

test("订单与报告失败态只渲染本地 URL，并提供安全重试", () => {
  const apiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  const orderSource = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.ts", import.meta.url), "utf8");
  const orderMarkup = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.wxml", import.meta.url), "utf8");
  const orderStyle = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.wxss", import.meta.url), "utf8");
  const reportMarkup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxml", import.meta.url), "utf8");
  const repairMarkup = readFileSync(new URL("../miniprogram/packages/repair/pages/owner-request-detail/owner-request-detail.wxml", import.meta.url), "utf8");
  assert.match(apiSource, /booking:\s*async \(id: string\) => localizeOwnerBookingPrivateMedia/u);
  assert.match(orderSource, /localizeOwnerMedia\(item\.sourceUrl, \{ forceRefresh: true \}\)/u);
  assert.match(orderMarkup, /bindtap="retryBookingMedia"/u);
  assert.match(orderMarkup, /binderror="handleBookingMediaError"/u);
  assert.match(reportMarkup, /部分私有照片安全读取失败/u);
  assert.match(reportMarkup, /binderror="handlePrivateImageError"/u);
  assert.match(repairMarkup, /binderror="handlePrivatePhotoError"/u);
  assert.doesNotMatch(`${orderMarkup}\n${reportMarkup}\n${repairMarkup}`, /src="\{\{[^}]*sourceUrl[^}]*\}\}"/u);
  assert.match(orderStyle, /\.evidence-image-viewer-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(80rpx,\s*104rpx\)\s+minmax\(0,\s*1fr\)[^}]*box-sizing:\s*border-box/u);
  assert.match(orderStyle, /\.evidence-image-viewer-controls button\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/u);
});
