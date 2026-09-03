import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

type ImageCase = {
  file: string;
  binding: string;
  fallback?: string;
};

const cases: ImageCase[] = [
  { file: "miniprogram/pages/home/home.wxml", binding: "{{hero.vehicleImage}}", fallback: "vehicleImageError" },
  { file: "miniprogram/packages/wash/pages/wash-stores/wash-stores.wxml", binding: "{{item.coverSrc}}", fallback: "coverError" },
  { file: "miniprogram/packages/wash/pages/wash-stores/wash-stores.wxml", binding: "{{imageUrl}}", fallback: "galleryError" },
  { file: "miniprogram/packages/wash/pages/wash-booking/wash-booking.wxml", binding: "{{selectedStoreCoverUrl}}", fallback: "selectedStoreCoverError" },
  { file: "miniprogram/packages/vehicle/pages/vehicle-form/vehicle-form.wxml", binding: "{{selectedModelImage}}", fallback: "vehicleImageError" },
  { file: "miniprogram/packages/vehicle/pages/vehicle-form/vehicle-form.wxml", binding: "{{item.logoUrl}}" },
  { file: "miniprogram/packages/vehicle/pages/vehicle-form/vehicle-form.wxml", binding: "{{item.imageUrl}}" },
  { file: "miniprogram/packages/vehicle/pages/vehicles/vehicles.wxml", binding: "{{item.vehicleImage}}", fallback: "vehicleImageError" },
  { file: "miniprogram/packages/annual/pages/eligibility/eligibility.wxml", binding: "{{selectedVehicleImage}}", fallback: "selectedVehicleImageError" },
  { file: "miniprogram/packages/car-rental/pages/car-rental-home/car-rental-home.wxml", binding: "{{item.model.imageUrl}}", fallback: "hotImageError" },
  { file: "miniprogram/packages/car-rental/pages/car-rental-offers/car-rental-offers.wxml", binding: "{{item.model.imageUrl}}", fallback: "imageError" },
  { file: "miniprogram/packages/car-rental/pages/car-rental-offers/car-rental-offers.wxml", binding: "{{item.logoUrl}}" },
  { file: "miniprogram/packages/car-rental/pages/car-rental-offers/car-rental-offers.wxml", binding: "{{brand.logoUrl}}" },
  { file: "miniprogram/packages/car-rental/pages/car-rental-detail/car-rental-detail.wxml", binding: "{{item.url}}", fallback: "imageError" },
  { file: "miniprogram/packages/car-rental/pages/car-rental-detail/car-rental-detail.wxml", binding: "{{model.brandLogoUrl}}", fallback: "brandLogoError" },
  { file: "miniprogram/packages/car-rental/pages/car-rental-confirm/car-rental-confirm.wxml", binding: "{{quote.model.imageUrl}}", fallback: "modelImageError" },
  { file: "miniprogram/packages/car-rental/pages/car-rental-orders/car-rental-orders.wxml", binding: "{{item.model.imageUrl}}", fallback: "modelImageError" },
  { file: "miniprogram/packages/car-rental/pages/car-rental-order-detail/car-rental-order-detail.wxml", binding: "{{order.model.imageUrl}}", fallback: "modelImageError" },
  { file: "miniprogram/packages/driving-school/pages/list/list.wxml", binding: "{{item.coverImage}}", fallback: "imageError" },
  { file: "miniprogram/packages/driving-school/pages/detail/detail.wxml", binding: "{{item.url}}", fallback: "imageError" },
  { file: "miniprogram/packages/driving-school/pages/inquiry/inquiry.wxml", binding: "{{coverImage}}", fallback: "imageError" },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function imageTag(source: string, binding: string): string {
  const match = source.match(new RegExp(`<image\\b[^>]*\\bsrc="${escapeRegex(binding)}"[^>]*\\/?>`, "u"));
  assert.ok(match, `missing image binding ${binding}`);
  return match[0];
}

test("network-backed catalog images opt into WebP decoding on real devices", () => {
  for (const item of cases) {
    const source = readFileSync(new URL(`../${item.file}`, import.meta.url), "utf8");
    const tag = imageTag(source, item.binding);
    assert.match(tag, /\bwebp="\{\{true\}\}"/u, `${item.file} ${item.binding} must enable WebP decoding`);
  }
});

test("critical catalog images retain an explicit load-error fallback", () => {
  for (const item of cases.filter((candidate) => candidate.fallback)) {
    const source = readFileSync(new URL(`../${item.file}`, import.meta.url), "utf8");
    const tag = imageTag(source, item.binding);
    assert.match(tag, new RegExp(`\\bbinderror="${escapeRegex(item.fallback as string)}"`, "u"), `${item.file} ${item.binding} must keep its fallback handler`);
  }
});

test("static local icons are not globally forced through the WebP decoder", () => {
  const source = readFileSync(new URL("../miniprogram/pages/home/home.wxml", import.meta.url), "utf8");
  const icon = imageTag(source, "../../assets/icons/shield-check.png");
  assert.doesNotMatch(icon, /\bwebp=/u);
});

test("rental home never disguises multiple failed model images as the same vehicle", () => {
  const logic = readFileSync(new URL("../miniprogram/packages/car-rental/pages/car-rental-home/car-rental-home.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/car-rental/pages/car-rental-home/car-rental-home.wxml", import.meta.url), "utf8");
  assert.match(logic, /imageLoadFailed/u);
  assert.doesNotMatch(logic, /hotOffers\[\$\{index\}\]\.model\.imageUrl[^\n]+hero-car-generic/u);
  assert.match(markup, /车型图片暂不可用/u);
});
