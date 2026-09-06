import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selectionsPath = resolve(workspaceRoot, process.argv[2] ?? "wechat-miniprogram/.asset-preview/commons-owner-candidates-bmw/selections.json");
const outputPath = resolve(workspaceRoot, process.argv[3] ?? "wechat-miniprogram/artifacts/owner-presentation-batch.jpg");
const selections = JSON.parse(await readFile(selectionsPath, "utf8"));
const columns = 5;
const cardWidth = 360;
const cardHeight = 245;
const rows = Math.ceil(selections.length / columns);
const composites = [];

for (let index = 0; index < selections.length; index += 1) {
  const { modelId } = selections[index];
  const x = (index % columns) * cardWidth;
  const y = Math.floor(index / columns) * cardHeight;
  const presentationPath = resolve(workspaceRoot, `public/assets/used-cars/owner-presentation-v2/${modelId}.webp`);
  const vehiclePath = existsSync(presentationPath)
    ? presentationPath
    : resolve(workspaceRoot, `public/assets/used-cars/owner-models/${modelId}.webp`);
  const vehicle = await sharp(vehiclePath)
    .resize(cardWidth - 20, cardHeight - 48, { fit: "contain" })
    .png()
    .toBuffer();
  composites.push({ input: vehicle, left: x + 10, top: y + 38 });
  const safeLabel = modelId.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const label = Buffer.from(`<svg width="${cardWidth}" height="38" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#eef3f8"/><text x="16" y="25" font-family="Arial, sans-serif" font-size="17" font-weight="600" fill="#24364b">${safeLabel}</text></svg>`);
  composites.push({ input: label, left: x, top: y });
}

await mkdir(dirname(outputPath), { recursive: true });
await sharp({ create: { width: columns * cardWidth, height: rows * cardHeight, channels: 3, background: "#f8fafc" } })
  .composite(composites)
  .jpeg({ quality: 91, chromaSubsampling: "4:4:4" })
  .toFile(outputPath);
console.log(`Built ${selections.length}-asset contact sheet: ${outputPath}`);
