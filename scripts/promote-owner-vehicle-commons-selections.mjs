import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selectionsPath = resolve(workspaceRoot, process.argv[2] ?? "wechat-miniprogram/.asset-preview/commons-owner-candidates-bmw/selections.json");
const sourcesPath = resolve(workspaceRoot, "references/owner-vehicle-commons-sources.json");
const inventoryPath = resolve(workspaceRoot, "references/owner-vehicle-presentation-inventory.json");
const sourceRoot = resolve(workspaceRoot, "public/assets/used-cars/real-sources/owner-models");

const [selections, report, inventory] = await Promise.all([
  readFile(selectionsPath, "utf8").then(JSON.parse),
  readFile(sourcesPath, "utf8").then(JSON.parse),
  readFile(inventoryPath, "utf8").then(JSON.parse),
]);
const inventoryById = new Map(inventory.entries.map((entry) => [entry.modelId, entry]));
const selectedIds = new Set(selections.map((selection) => selection.modelId));

for (const selection of selections) {
  const outputPath = resolve(sourceRoot, selection.modelId, "cover.webp");
  await mkdir(dirname(outputPath), { recursive: true });
  const response = await fetch(selection.thumbUrl, {
    headers: { "user-agent": "YuxiaomanVehicleCatalog/1.0 (licensed asset ingestion)" },
  });
  if (!response.ok) throw new Error(`${selection.modelId}: Commons download failed (${response.status})`);
  await sharp(Buffer.from(await response.arrayBuffer()))
    .resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 90, effort: 5 })
    .toFile(outputPath);
}

const promoted = selections.map((selection) => {
  const inventoryEntry = inventoryById.get(selection.modelId);
  if (!inventoryEntry) throw new Error(`Catalog model not found: ${selection.modelId}`);
  return {
    modelId: selection.modelId,
    displayName: `${inventoryEntry.brandName} ${inventoryEntry.modelName}`,
    identityScope: "series_reference_not_specific_model_year",
    sourceTitle: selection.title,
    sourcePageUrl: selection.sourcePageUrl,
    originalUrl: selection.originalUrl,
    sourceDimensions: { width: selection.width, height: selection.height },
    author: selection.author,
    credit: selection.credit,
    license: selection.license,
    licenseUrl: selection.licenseUrl,
    description: selection.description,
    localSource: `public/assets/used-cars/real-sources/owner-models/${selection.modelId}/cover.webp`,
    exactSeriesVisualReview: "passed",
    presentationGenerationStatus: "pending",
  };
});

report.generatedAt = new Date().toISOString();
report.selectionPolicy = "Every source title and reviewed image identify the bound catalog series. Sources establish series identity; final presentation assets require a separate fixed-angle visual review.";
report.sources = [
  ...report.sources.filter((source) => !selectedIds.has(source.modelId)),
  ...promoted,
];
await writeFile(sourcesPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Promoted ${promoted.length} exact-series Commons references; report now contains ${report.sources.length}.`);
