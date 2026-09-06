import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  mediaUrl,
  normalizeWashStore,
  rentalImageUrl,
  usedCarImageUrl,
} from "../miniprogram/services/api";
import { apiOrigin } from "../miniprogram/config/env";

test("后台历史 localhost 图片地址统一改写到当前 API origin", () => {
  const expected = mediaUrl("/api/uploads/example.jpg?version=2");
  for (const source of [
    "http://localhost:8000/api/uploads/example.jpg?version=2",
    "http://127.0.0.1:3000/api/uploads/example.jpg?version=2",
    "http://0.0.0.0:8792/api/uploads/example.jpg?version=2",
  ]) {
    assert.equal(mediaUrl(source), expected);
    assert.equal(rentalImageUrl(source), expected);
    assert.equal(usedCarImageUrl(source), expected);
  }
});

test("洗车门店 normalizer 改写历史回环地址，外部 CDN 与包内资源保持不变", () => {
  const normalized = normalizeWashStore({
    id: "store-legacy-images",
    coverImageUrl: "http://localhost:8000/api/wash/store-images/cover",
    images: [{ id: "gallery", url: "http://127.0.0.1:8000/api/wash/store-images/gallery" }],
  } as never);
  assert.equal(normalized.coverImageUrl, mediaUrl("/api/wash/store-images/cover"));
  assert.equal(normalized.images?.[0]?.url, mediaUrl("/api/wash/store-images/gallery"));
  assert.equal(mediaUrl("https://cdn.example.com/photo.jpg"), "https://cdn.example.com/photo.jpg");
  assert.equal(mediaUrl("/assets/icons/camera.png"), "/assets/icons/camera.png");
  assert.equal(mediaUrl("/packages/wash/assets/store.jpg"), "/packages/wash/assets/store.jpg");
});

test("租车车型与品牌资源指向 API 静态目录，不误判为小程序包内图片", () => {
  const modelPath = "/assets/used-cars/models/model-li-l7.webp?v=real-model-v1";
  const otherModelPath = "/assets/used-cars/models/model-byd-qin-plus.webp?v=real-model-v1";
  const logoPath = "/assets/used-cars/logos/brand-li.webp";

  assert.equal(rentalImageUrl(modelPath), `${apiOrigin}${modelPath}`);
  assert.equal(rentalImageUrl(otherModelPath), `${apiOrigin}${otherModelPath}`);
  assert.equal(rentalImageUrl(logoPath), `${apiOrigin}${logoPath}`);
  assert.equal(usedCarImageUrl(modelPath), `${apiOrigin}${modelPath}`);
  assert.equal(mediaUrl("/assets/driving-schools/c-class.webp"), `${apiOrigin}/assets/driving-schools/c-class.webp`);
  assert.equal(
    mediaUrl("/assets/used-cars/owner-presentation-v2/vehicle-example.webp"),
    `${apiOrigin}/assets/used-cars/owner-presentation-v2/vehicle-example.webp`,
  );
  assert.notEqual(rentalImageUrl(modelPath), rentalImageUrl(otherModelPath));
  assert.equal(rentalImageUrl("/assets/brand/hero-car-generic.png"), "/assets/brand/hero-car-generic.png");
});

test("动态图片页面具备单图失败恢复，不因一张失效清空整组", () => {
  const washSource = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-stores/wash-stores.ts", import.meta.url), "utf8");
  const washMarkup = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-stores/wash-stores.wxml", import.meta.url), "utf8");
  const repairOwnerMarkup = readFileSync(new URL("../miniprogram/packages/repair/pages/owner-request-detail/owner-request-detail.wxml", import.meta.url), "utf8");
  const repairShopMarkup = readFileSync(new URL("../miniprogram/packages/repair/pages/shop-request-detail/shop-request-detail.wxml", import.meta.url), "utf8");
  assert.match(washSource, /galleryError\(event\)/u);
  assert.match(washMarkup, /binderror="galleryError"/u);
  assert.match(repairOwnerMarkup, /binderror="handlePrivatePhotoError"/u);
  assert.match(repairShopMarkup, /binderror="handlePrivatePhotoError"/u);
});
