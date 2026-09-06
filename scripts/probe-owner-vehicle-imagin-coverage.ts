import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { VEHICLE_CATALOG } from "../server/vehicle-catalog.js";
import { imaginStudioPresentationUrl } from "../server/vehicle-catalog-imagin.js";

type ProbeEntry = {
  modelId: string;
  brandName: string;
  modelName: string;
  vehicleClassCodes: string[];
  providerRequest: { make: string; modelFamily: string; angle: "28"; paintDescription: "white"; zoomType: "relative" };
  checkedAt: string;
  httpStatus: number | null;
  contentType: string;
  requestFound: boolean | null;
  requestResolved: boolean | null;
  performedMatches: string;
  candidateStatus: "exact_match_candidate" | "provider_substitute_or_pending" | "request_failed";
  exactMatchReview: "pending";
  error: string;
};

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const integerOption = (name: string, fallback: number) => {
  const raw = option(name);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
};
const dryRun = args.includes("--dry-run");
const modelId = option("--model-id");
const offset = integerOption("--offset", 0);
const limit = integerOption("--limit", modelId ? 1 : 50);
const concurrency = Math.max(1, Math.min(6, integerOption("--concurrency", 3)));
const outputUrl = new URL("../references/owner-vehicle-imagin-probe.json", import.meta.url);

const candidates = VEHICLE_CATALOG.flatMap((brand) => brand.models.map((model) => ({
  modelId: model.id,
  brandName: brand.name,
  modelName: model.name,
  imageUrl: model.imageUrl,
  vehicleClassCodes: model.vehicleClassCodes,
}))).filter((entry) => !entry.imageUrl && (
  entry.vehicleClassCodes.includes("passenger_car") || entry.vehicleClassCodes.includes("small_truck")
));
const selected = (modelId ? candidates.filter((entry) => entry.modelId === modelId) : candidates.slice(offset, offset + limit));
if (modelId && selected.length !== 1) throw new Error(`Unknown or already-approved provider candidate: ${modelId}`);

if (dryRun) {
  console.log(JSON.stringify({ totalCandidates: candidates.length, selected: selected.length, offset, limit, concurrency }, null, 2));
  process.exit(0);
}

const customerKey = process.env.IMAGIN_STUDIO_CUSTOMER_KEY?.trim() ?? "";
if (!customerKey) throw new Error("IMAGIN_STUDIO_CUSTOMER_KEY is required. The probe never logs or stores it.");

const existing = await readFile(outputUrl, "utf8").then((value) => JSON.parse(value) as { entries?: ProbeEntry[] }).catch(() => ({ entries: [] }));
const byId = new Map((existing.entries ?? []).map((entry) => [entry.modelId, entry] as const));

async function probe(entry: (typeof selected)[number]): Promise<ProbeEntry> {
  const mapping = { make: entry.brandName, modelFamily: entry.modelName };
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(imaginStudioPresentationUrl(customerKey, mapping), {
      headers: { accept: "image/webp" },
      signal: AbortSignal.timeout(20_000),
    });
    const requestFoundHeader = response.headers.get("x-imaginstudio-request-found");
    const requestResolvedHeader = response.headers.get("x-imaginstudio-request-resolved");
    const requestFound = requestFoundHeader ? requestFoundHeader.toLowerCase() === "true" : null;
    const requestResolved = requestResolvedHeader ? requestResolvedHeader.toLowerCase() === "true" : null;
    const contentType = response.headers.get("content-type") ?? "";
    const performedMatches = response.headers.get("x-imaginstudio-performed-matches") ?? "";
    await response.body?.cancel();
    const exactCandidate = response.ok && contentType.startsWith("image/") && requestFound === true && requestResolved === true;
    return {
      ...entry,
      providerRequest: { ...mapping, angle: "28", paintDescription: "white", zoomType: "relative" },
      checkedAt,
      httpStatus: response.status,
      contentType,
      requestFound,
      requestResolved,
      performedMatches,
      candidateStatus: exactCandidate ? "exact_match_candidate" : "provider_substitute_or_pending",
      exactMatchReview: "pending",
      error: "",
    };
  } catch (error) {
    return {
      ...entry,
      providerRequest: { ...mapping, angle: "28", paintDescription: "white", zoomType: "relative" },
      checkedAt,
      httpStatus: null,
      contentType: "",
      requestFound: null,
      requestResolved: null,
      performedMatches: "",
      candidateStatus: "request_failed",
      exactMatchReview: "pending",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

for (let index = 0; index < selected.length; index += concurrency) {
  const batch = await Promise.all(selected.slice(index, index + concurrency).map(probe));
  for (const result of batch) {
    byId.set(result.modelId, result);
    console.log(`${result.modelId}: ${result.candidateStatus}`);
  }
}

const entries = [...byId.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  provider: "IMAGIN.studio",
  customerKeyFingerprint: createHash("sha256").update(customerKey).digest("hex").slice(0, 12),
  rule: "Provider headers can nominate a candidate, but only a visual exact-series review may publish it.",
  entries,
};
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Wrote ${entries.length} resumable probe rows to ${outputUrl.pathname}.`);
