import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const picksPath = resolve(workspaceRoot, process.argv[2]);
const outputDir = resolve(workspaceRoot, process.argv[3]);
const sheetPath = resolve(workspaceRoot, process.argv[4] ?? `${outputDir}/candidates.jpg`);
if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: node prepare-owner-vehicle-commons-review.mjs <picks.json> <output-dir> [sheet.jpg]");

const [picks, probe] = await Promise.all([
  readFile(picksPath, "utf8").then(JSON.parse),
  readFile(resolve(workspaceRoot, "references/owner-vehicle-commons-probe.json"), "utf8").then(JSON.parse),
]);
const entriesById = new Map(probe.entries.map((entry) => [entry.modelId, entry]));
await mkdir(outputDir, { recursive: true });

const selections = [];
for (const [modelId, candidateIndex] of Object.entries(picks)) {
  const entry = entriesById.get(modelId);
  const candidate = entry?.candidates?.[candidateIndex];
  if (!candidate) throw new Error(`${modelId}: candidate ${candidateIndex} not found`);
  const localPreview = resolve(outputDir, `${modelId}.webp`);
  const response = await fetch(candidate.thumbUrl, { headers: { "user-agent": "YuxiaomanVehicleCatalog/1.0 (licensed asset visual review)" } });
  if (!response.ok) throw new Error(`${modelId}: preview download failed (${response.status})`);
  await sharp(Buffer.from(await response.arrayBuffer()))
    .resize(1000, 700, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 88 })
    .toFile(localPreview);
  selections.push({
    modelId,
    candidateIndex,
    ...candidate,
    localPreview: localPreview.slice(workspaceRoot.length + 1),
  });
}
await writeFile(resolve(outputDir, "selections.json"), `${JSON.stringify(selections, null, 2)}\n`, "utf8");

const columns = 5;
const cardWidth = 360;
const cardHeight = 250;
const rows = Math.ceil(selections.length / columns);
const composites = [];
for (let index = 0; index < selections.length; index += 1) {
  const selection = selections[index];
  const x = (index % columns) * cardWidth;
  const y = Math.floor(index / columns) * cardHeight;
  const image = await sharp(resolve(outputDir, `${selection.modelId}.webp`))
    .resize(cardWidth - 16, cardHeight - 46, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 88 })
    .toBuffer();
  const safeLabel = selection.modelId.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const label = Buffer.from(`<svg width="${cardWidth}" height="38" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#eef3f8"/><text x="12" y="25" font-family="Arial, sans-serif" font-size="16" font-weight="600" fill="#24364b">${safeLabel}</text></svg>`);
  composites.push({ input: label, left: x, top: y }, { input: image, left: x + 8, top: y + 42 });
}
await mkdir(dirname(sheetPath), { recursive: true });
await sharp({ create: { width: columns * cardWidth, height: rows * cardHeight, channels: 3, background: "#ffffff" } })
  .composite(composites)
  .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
  .toFile(sheetPath);
console.log(`Prepared ${selections.length} candidates in ${basename(outputDir)}; sheet: ${sheetPath}`);
