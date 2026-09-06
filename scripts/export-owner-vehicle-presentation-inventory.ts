import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VEHICLE_CATALOG } from "../server/vehicle-catalog.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const referencesRoot = resolve(workspaceRoot, "references");
const jsonPath = resolve(referencesRoot, "owner-vehicle-presentation-inventory.json");
const csvPath = resolve(referencesRoot, "owner-vehicle-presentation-provider-intake.csv");

const STANDARD = Object.freeze({
  vehicleColor: "white",
  cameraAngle: "front-left three-quarter",
  imaginStudioAngle: "28",
  framing: "full vehicle, consistent relative scale and margins",
  background: "transparent",
  shadow: "restrained studio contact shadow",
  width: 800,
  fileType: "webp",
  zoomType: "relative",
});

function csvCell(value: unknown) {
  const stringValue = String(value ?? "");
  return /[",\r\n]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
}

const entries = VEHICLE_CATALOG.flatMap((brand) => brand.models.map((model) => {
  const providerLane = model.vehicleClassCodes.includes("passenger_car")
    ? "imagin_studio_passenger"
    : model.vehicleClassCodes.includes("small_truck")
      ? "imagin_studio_lcv_or_curated"
      : "curated_commercial";
  const ready = Boolean(model.imageUrl);
  return {
    modelId: model.id,
    brandId: brand.id,
    brandName: brand.name,
    modelName: model.name,
    vehicleClassCodes: model.vehicleClassCodes,
    status: ready ? "approved" : "source_required",
    publishable: ready,
    currentImageUrl: model.imageUrl,
    providerLane: ready ? "owned_reviewed_asset" : providerLane,
    providerMake: brand.name,
    providerModelFamily: model.name,
    providerModelYear: "",
    requestedPaintDescription: STANDARD.vehicleColor,
    requestedAngle: STANDARD.imaginStudioAngle,
    requestedZoomType: STANDARD.zoomType,
    requestedFileType: STANDARD.fileType,
    requestedWidth: STANDARD.width,
    exactMatchReview: ready ? "passed" : "pending",
    targetAssetPath: ready
      ? model.imageUrl
      : `/assets/used-cars/owner-presentation-full/${model.id}.webp`,
  };
}));

const classCounts: Record<string, number> = {};
for (const entry of entries) {
  for (const code of entry.vehicleClassCodes) classCounts[code] = (classCounts[code] ?? 0) + 1;
}

const summary = {
  brands: VEHICLE_CATALOG.length,
  models: entries.length,
  approved: entries.filter((entry) => entry.publishable).length,
  sourceRequired: entries.filter((entry) => !entry.publishable).length,
  providerLanes: Object.fromEntries(
    [...new Set(entries.map((entry) => entry.providerLane))]
      .sort()
      .map((lane) => [lane, entries.filter((entry) => entry.providerLane === lane).length]),
  ),
  vehicleClassAssignments: classCounts,
};

if (summary.brands !== 148 || summary.models !== 1_581) {
  throw new Error(`Unexpected owner catalog size: ${summary.brands} brands / ${summary.models} models.`);
}

const inventory = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  standard: STANDARD,
  releaseRule: "Publish only after an exact-series match passes visual review; never reuse another model or expose a provider substitute/placeholder.",
  delivery: "Server-provided catalog metadata with lazy remote loading; vehicle images do not enter the mini-program package.",
  summary,
  entries,
};

const csvColumns = [
  "modelId", "brandId", "brandName", "modelName", "vehicleClassCodes", "status", "publishable",
  "providerLane", "providerMake", "providerModelFamily", "providerModelYear", "exactMatchReview", "currentImageUrl", "targetAssetPath",
  "requestedPaintDescription", "requestedAngle", "requestedZoomType", "requestedFileType", "requestedWidth",
];
const csv = [
  csvColumns.join(","),
  ...entries.map((entry) => csvColumns.map((column) => {
    const value = entry[column as keyof typeof entry];
    return csvCell(Array.isArray(value) ? value.join("|") : value);
  }).join(",")),
].join("\r\n") + "\r\n";

await mkdir(referencesRoot, { recursive: true });
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8"),
  writeFile(csvPath, csv, "utf8"),
]);

console.log(JSON.stringify({ jsonPath, csvPath, summary }, null, 2));
