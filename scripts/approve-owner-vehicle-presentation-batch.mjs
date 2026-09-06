import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selectionsPath = resolve(workspaceRoot, process.argv[2] ?? "wechat-miniprogram/.asset-preview/commons-owner-candidates-bmw/selections.json");
const manifestPath = resolve(workspaceRoot, "references/owner-vehicle-presentation-v2.json");
const commonsPath = resolve(workspaceRoot, "references/owner-vehicle-commons-sources.json");
const imageMapPath = resolve(workspaceRoot, "server/vehicle-catalog-images.ts");

const [selections, manifest, commons] = await Promise.all([
  readFile(selectionsPath, "utf8").then(JSON.parse),
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(commonsPath, "utf8").then(JSON.parse),
]);
const ids = selections.map((selection) => selection.modelId);

for (const id of ids) {
  await access(resolve(workspaceRoot, `source-assets/owner-vehicle-presentation-v2/${id}.png`));
  await access(resolve(workspaceRoot, `public/assets/used-cars/owner-presentation-v2/${id}.webp`));
}

manifest.generatedModels = [...new Set([...manifest.generatedModels, ...ids])].sort();
for (const id of ids) {
  manifest.exactModelReferences[id] = `public/assets/used-cars/real-sources/owner-models/${id}/cover.webp`;
}
manifest.exactModelReferences = Object.fromEntries(Object.entries(manifest.exactModelReferences).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const idSet = new Set(ids);
for (const source of commons.sources) {
  if (!idSet.has(source.modelId)) continue;
  source.presentationGenerationStatus = "passed";
  source.presentationAsset = `public/assets/used-cars/owner-presentation-v2/${source.modelId}.webp`;
}
commons.generatedAt = new Date().toISOString();
await writeFile(commonsPath, `${JSON.stringify(commons, null, 2)}\n`, "utf8");

let imageMap = await readFile(imageMapPath, "utf8");
const missing = ids.filter((id) => !imageMap.includes(`"${id}": presentationV2`));
if (missing.length) {
  const marker = '  "vehicle-aito-m7": presentationV2("vehicle-aito-m7"),';
  const block = `${missing.map((id) => `  "${id}": presentationV2("${id}"),`).join("\n")}\n`;
  if (!imageMap.includes(marker)) throw new Error("Vehicle image map insertion marker not found.");
  imageMap = imageMap.replace(marker, `${block}${marker}`);
  await writeFile(imageMapPath, imageMap, "utf8");
}

console.log(`Approved ${ids.length} presentation assets; ${missing.length} catalog mappings added.`);
