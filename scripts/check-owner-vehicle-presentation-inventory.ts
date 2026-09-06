import { readFile } from "node:fs/promises";
import { VEHICLE_CATALOG } from "../server/vehicle-catalog.js";

type InventoryEntry = {
  modelId: string;
  brandId: string;
  brandName: string;
  modelName: string;
  vehicleClassCodes: string[];
  publishable: boolean;
  currentImageUrl: string;
  exactMatchReview: "passed" | "pending";
};

type Inventory = {
  schemaVersion: number;
  standard: { vehicleColor: string; cameraAngle: string; imaginStudioAngle: string; background: string; zoomType: string };
  summary: { brands: number; models: number; approved: number; sourceRequired: number };
  entries: InventoryEntry[];
};

const inventory = JSON.parse(await readFile(
  new URL("../references/owner-vehicle-presentation-inventory.json", import.meta.url),
  "utf8",
)) as Inventory;
const catalogEntries = VEHICLE_CATALOG.flatMap((brand) => brand.models.map((model) => ({ brand, model })));

if (inventory.schemaVersion !== 1) throw new Error("Unsupported owner vehicle presentation inventory schema.");
if (inventory.standard.vehicleColor !== "white"
  || inventory.standard.cameraAngle !== "front-left three-quarter"
  || inventory.standard.imaginStudioAngle !== "28"
  || inventory.standard.background !== "transparent"
  || inventory.standard.zoomType !== "relative") {
  throw new Error("Owner vehicle presentation standard drifted from the approved fixed-angle treatment.");
}
if (inventory.summary.brands !== 148 || inventory.summary.models !== 1_581
  || inventory.entries.length !== catalogEntries.length) {
  throw new Error("Owner vehicle presentation inventory must cover all 148 brands and 1,581 models.");
}

const inventoryById = new Map(inventory.entries.map((entry) => [entry.modelId, entry] as const));
if (inventoryById.size !== inventory.entries.length) throw new Error("Duplicate model ID in owner presentation inventory.");

for (const { brand, model } of catalogEntries) {
  const entry = inventoryById.get(model.id);
  if (!entry) throw new Error(`Missing owner presentation inventory row: ${model.id}`);
  if (entry.brandId !== brand.id || entry.brandName !== brand.name || entry.modelName !== model.name
    || entry.vehicleClassCodes.join("|") !== model.vehicleClassCodes.join("|")) {
    throw new Error(`Catalog metadata mismatch in owner presentation inventory: ${model.id}`);
  }
  if (entry.currentImageUrl !== model.imageUrl || entry.publishable !== Boolean(model.imageUrl)) {
    throw new Error(`Publish state mismatch in owner presentation inventory: ${model.id}`);
  }
  if ((entry.exactMatchReview === "passed") !== entry.publishable) {
    throw new Error(`Exact-match review state mismatch in owner presentation inventory: ${model.id}`);
  }
}

const approved = inventory.entries.filter((entry) => entry.publishable).length;
if (inventory.summary.approved !== approved || inventory.summary.sourceRequired !== inventory.entries.length - approved) {
  throw new Error("Owner presentation inventory summary is stale.");
}

console.log(`Owner-vehicle inventory QA passed: ${inventory.entries.length} model rows, ${approved} approved, ${inventory.entries.length - approved} awaiting exact-series presentation assets.`);
