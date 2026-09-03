import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const projectRoot = new URL("../", import.meta.url);
const sourceRoot = new URL("../source-assets/owner-vehicles/", import.meta.url);
const modelOutputRoot = new URL("../public/assets/used-cars/owner-models/", import.meta.url);
const miniBrandRoot = new URL("../wechat-miniprogram/miniprogram/assets/brand/", import.meta.url);
const miniVehicleRoot = new URL("../wechat-miniprogram/miniprogram/assets/vehicles/", import.meta.url);
const miniVehicleLogoRoot = new URL("../wechat-miniprogram/miniprogram/assets/vehicles/logos/", import.meta.url);
const publicLogoRoot = new URL("../public/assets/used-cars/logos/", import.meta.url);

const modelIds = [
  "vehicle-mercedes-s",
  "vehicle-mercedes-e",
  "vehicle-mercedes-glc",
  "vehicle-bmw-3",
  "vehicle-bmw-5",
  "vehicle-bmw-x3",
  "vehicle-audi-a4l",
  "vehicle-audi-a6l",
  "vehicle-audi-q5l",
  "vehicle-tesla-model-y",
  "vehicle-byd-han",
  "vehicle-li-l7",
];

const brandIds = ["brand-mercedes", "brand-bmw", "brand-audi", "brand-tesla", "brand-byd", "brand-li"];

const localPngOptions = {
  palette: true,
  quality: 100,
  colours: 256,
  dither: 0.8,
  compressionLevel: 9,
};

function removeMagenta(data, channels) {
  for (let offset = 0; offset < data.length; offset += channels) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    const chroma = Math.min(red, blue) - green;
    const looksMagenta = red > 45 && blue > 45 && red > green * 1.28 && blue > green * 1.28 && chroma > 24;
    if (!looksMagenta) continue;

    const opacity = Math.max(0, Math.min(1, (78 - chroma) / 54));
    data[offset + 3] = Math.round(alpha * opacity);
    if (opacity < 1) {
      const neutral = Math.max(green, Math.round((red + green + blue) / 3));
      data[offset] = neutral;
      data[offset + 1] = neutral;
      data[offset + 2] = neutral;
    }
  }
  return data;
}

async function buildVehicle(id) {
  const input = join(sourceRoot.pathname.slice(1), `${id}.png`);
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  removeMagenta(data, info.channels);
  const transparent = await sharp(data, { raw: info })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 })
    .resize(1040, 570, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const presentationCanvas = await sharp({
    create: { width: 1120, height: 630, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: transparent, gravity: "center" }])
    .png()
    .toBuffer();
  await sharp(presentationCanvas)
    .webp({ quality: 84, alphaQuality: 92, effort: 6 })
    .toFile(join(modelOutputRoot.pathname.slice(1), `${id}.webp`));
  await sharp(presentationCanvas)
    .resize(720, 405, { fit: "contain", withoutEnlargement: true })
    .png(localPngOptions)
    .toFile(join(miniVehicleRoot.pathname.slice(1), `${id}.png`));
}

await mkdir(modelOutputRoot, { recursive: true });
await mkdir(miniBrandRoot, { recursive: true });
await mkdir(miniVehicleRoot, { recursive: true });
await mkdir(miniVehicleLogoRoot, { recursive: true });

await sharp(join(sourceRoot.pathname.slice(1), "hero-tianjin-background.png"))
  .resize(1200, 900, { fit: "cover" })
  .jpeg({ quality: 90, mozjpeg: true })
  .toFile(join(miniBrandRoot.pathname.slice(1), "hero-tianjin-background.jpg"));

for (const id of modelIds) await buildVehicle(id);

for (const id of brandIds) {
  await sharp(join(publicLogoRoot.pathname.slice(1), `${id}.png`))
    .resize(96, 96, { fit: "contain", withoutEnlargement: true })
    .png(localPngOptions)
    .toFile(join(miniVehicleLogoRoot.pathname.slice(1), `${id}.png`));
}

await sharp(join(modelOutputRoot.pathname.slice(1), "vehicle-mercedes-e.webp"))
  .toFile(join(miniBrandRoot.pathname.slice(1), "hero-car-generic.webp"));
await sharp(join(miniVehicleRoot.pathname.slice(1), "vehicle-mercedes-e.png"))
  .png(localPngOptions)
  .toFile(join(miniBrandRoot.pathname.slice(1), "hero-car-generic.png"));

console.log(`Built ${modelIds.length} owner-vehicle WebP/PNG assets, the local Tianjin JPG background, and ${brandIds.length} local PNG logos from ${sourceRoot.pathname} for ${projectRoot.pathname}`);
