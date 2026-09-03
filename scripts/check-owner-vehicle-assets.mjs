import { stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const projectRoot = new URL("../", import.meta.url);
const vehicleRoot = new URL("../wechat-miniprogram/miniprogram/assets/vehicles/", import.meta.url);
const logoRoot = new URL("../wechat-miniprogram/miniprogram/assets/vehicles/logos/", import.meta.url);
const genericPath = new URL("../wechat-miniprogram/miniprogram/assets/brand/hero-car-generic.png", import.meta.url);
const backgroundPath = new URL("../wechat-miniprogram/miniprogram/assets/brand/hero-tianjin-background.jpg", import.meta.url);

const modelIds = [
  "vehicle-mercedes-s", "vehicle-mercedes-e", "vehicle-mercedes-glc",
  "vehicle-bmw-3", "vehicle-bmw-5", "vehicle-bmw-x3",
  "vehicle-audi-a4l", "vehicle-audi-a6l", "vehicle-audi-q5l",
  "vehicle-tesla-model-y", "vehicle-byd-han", "vehicle-li-l7",
];
const brandIds = ["brand-mercedes", "brand-bmw", "brand-audi", "brand-tesla", "brand-byd", "brand-li"];

function windowsPath(url) {
  return url.pathname.slice(1);
}

async function verifyPng(path, expectedWidth, expectedHeight, maxBytes) {
  const [metadata, file] = await Promise.all([sharp(path).metadata(), stat(path)]);
  if (metadata.format !== "png" || metadata.width !== expectedWidth || metadata.height !== expectedHeight || !metadata.hasAlpha) {
    throw new Error(`${path} must be an alpha PNG at ${expectedWidth}x${expectedHeight}; got ${metadata.format} ${metadata.width}x${metadata.height} alpha=${metadata.hasAlpha}`);
  }
  if (file.size > maxBytes) throw new Error(`${path} is ${file.size} bytes, above the ${maxBytes}-byte mini-program budget.`);
  return file.size;
}

async function verifyJpeg(path, expectedWidth, expectedHeight, maxBytes) {
  const [metadata, file] = await Promise.all([sharp(path).metadata(), stat(path)]);
  if (metadata.format !== "jpeg" || metadata.width !== expectedWidth || metadata.height !== expectedHeight || metadata.hasAlpha) {
    throw new Error(`${path} must be an opaque JPEG at ${expectedWidth}x${expectedHeight}; got ${metadata.format} ${metadata.width}x${metadata.height} alpha=${metadata.hasAlpha}`);
  }
  if (file.size > maxBytes) throw new Error(`${path} is ${file.size} bytes, above the ${maxBytes}-byte mini-program budget.`);
  return file.size;
}

let vehicleBytes = 0;
for (const id of modelIds) {
  vehicleBytes += await verifyPng(join(windowsPath(vehicleRoot), `${id}.png`), 720, 405, 125_000);
}
for (const id of brandIds) {
  const path = join(windowsPath(logoRoot), `${id}.png`);
  const metadata = await sharp(path).metadata();
  if (metadata.format !== "png" || (metadata.width ?? 0) > 96 || (metadata.height ?? 0) > 96) {
    throw new Error(`${path} must be a PNG no larger than 96x96.`);
  }
  vehicleBytes += (await stat(path)).size;
}
vehicleBytes += await verifyPng(windowsPath(genericPath), 720, 405, 125_000);
const backgroundBytes = await verifyJpeg(windowsPath(backgroundPath), 1200, 900, 150_000);

console.log(`Owner-vehicle local-image QA passed: ${modelIds.length} PNG models, ${brandIds.length} PNG logos, one compatible Tianjin JPEG, ${((vehicleBytes + backgroundBytes) / 1024).toFixed(1)} KiB local visuals (${windowsPath(projectRoot)}). Package budgets are enforced by wechat-miniprogram/scripts/check-main-package-budget.cjs.`);
