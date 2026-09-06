import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const originalRoot = new URL("../public/assets/used-cars/owner-models/", import.meta.url);
const v2Root = new URL("../public/assets/used-cars/owner-presentation-v2/", import.meta.url);
const manifestUrl = new URL("../references/owner-vehicle-presentation-v2.json", import.meta.url);
const genericPath = new URL("../wechat-miniprogram/miniprogram/assets/brand/hero-car-generic.png", import.meta.url);
const backgroundPath = new URL("../wechat-miniprogram/miniprogram/assets/brand/hero-tianjin-background.jpg", import.meta.url);

const originalModels = [
  "vehicle-mercedes-s", "vehicle-mercedes-e", "vehicle-mercedes-glc",
  "vehicle-bmw-3", "vehicle-bmw-5", "vehicle-bmw-x3",
  "vehicle-audi-a4l", "vehicle-audi-a6l", "vehicle-audi-q5l",
  "vehicle-tesla-model-y", "vehicle-byd-han", "vehicle-li-l7",
];
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const generatedModels = manifest.generatedModels.map(String);
const allModels = [...originalModels, ...generatedModels];
if (new Set(allModels).size !== allModels.length) throw new Error("Presentation model ids must be unique.");

function windowsPath(url) { return url.pathname.slice(1); }

async function verifyPresentationWebp(path) {
  const [metadata, file, contents] = await Promise.all([sharp(path).metadata(), stat(path), readFile(path)]);
  if (metadata.format !== "webp" || metadata.width !== 1120 || metadata.height !== 630 || !metadata.hasAlpha) {
    throw new Error(`${path} must be an alpha WebP at 1120x630; got ${metadata.format} ${metadata.width}x${metadata.height} alpha=${metadata.hasAlpha}`);
  }
  if (file.size > 180_000) throw new Error(`${path} is ${file.size} bytes, above the server presentation budget.`);
  return { bytes: file.size, hash: createHash("sha256").update(contents).digest("hex") };
}

const results = [];
for (const id of originalModels) results.push(await verifyPresentationWebp(join(windowsPath(originalRoot), `${id}.webp`)));
for (const id of generatedModels) results.push(await verifyPresentationWebp(join(windowsPath(v2Root), `${id}.webp`)));
if (new Set(results.map((result) => result.hash)).size !== results.length) {
  throw new Error("A presentation image is reused across multiple model ids.");
}

const generic = await sharp(windowsPath(genericPath)).metadata();
if (generic.format !== "png" || generic.width !== 720 || generic.height !== 405 || !generic.hasAlpha) {
  throw new Error("The local empty-garage illustration must remain a 720x405 alpha PNG.");
}
const background = await sharp(windowsPath(backgroundPath)).metadata();
if (background.format !== "jpeg" || background.width !== 1200 || background.height !== 900) {
  throw new Error("The local Tianjin hero background must remain a 1200x900 JPEG.");
}

const bytes = results.reduce((sum, result) => sum + result.bytes, 0);
console.log(`Owner-vehicle presentation QA passed: ${allModels.length} unique fixed-angle 1120x630 alpha WebP assets, ${(bytes / 1024).toFixed(1)} KiB server-loaded total.`);
