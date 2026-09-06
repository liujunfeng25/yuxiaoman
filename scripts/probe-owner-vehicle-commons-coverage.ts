import { readFile, writeFile } from "node:fs/promises";
import { VEHICLE_CATALOG } from "../server/vehicle-catalog.js";

type CatalogEntry = {
  modelId: string;
  brandId: string;
  brandName: string;
  modelName: string;
  modelSlug: string;
  vehicleClassCodes: string[];
};

type CommonsCandidate = {
  pageId: number;
  title: string;
  sourcePageUrl: string;
  originalUrl: string;
  thumbUrl: string;
  width: number;
  height: number;
  mime: string;
  license: string;
  licenseUrl: string;
  author: string;
  credit: string;
  description: string;
  highConfidenceTitleMatch: boolean;
};

type ProbeEntry = CatalogEntry & {
  query: string;
  checkedAt: string;
  status: "high_confidence_candidate" | "review_candidates" | "no_candidate" | "request_failed";
  candidates: CommonsCandidate[];
  error: string;
};

type CommonsPage = {
  pageid?: number;
  title?: string;
  imageinfo?: Array<{
    url?: string;
    thumburl?: string;
    width?: number;
    height?: number;
    mime?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: string }>;
  }>;
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

const modelId = option("--model-id");
const offset = integerOption("--offset", 0);
const limit = integerOption("--limit", modelId ? 1 : 50);
const concurrency = Math.max(1, Math.min(2, integerOption("--concurrency", 2)));
const outputUrl = new URL("../references/owner-vehicle-commons-probe.json", import.meta.url);

const BRAND_SEARCH_NAMES: Record<string, string> = {
  mercedes: "Mercedes-Benz",
  bmw: "BMW",
  audi: "Audi",
  volkswagen: "Volkswagen",
  byd: "BYD",
  li: "Li Auto",
  xpeng: "XPeng",
  nio: "Nio",
  hongqi: "Hongqi",
  geely: "Geely",
  "geely-galaxy": "Geely Galaxy",
  lynk: "Lynk & Co",
  changan: "Changan",
  "changan-qiyuan": "Changan Qiyuan",
  "changan-oushang": "Changan Oshan",
  deepal: "Deepal",
  avatr: "Avatr",
  chery: "Chery",
  "chery-fulwin": "Chery Fulwin",
  "great-wall": "Great Wall",
  trumpchi: "GAC Trumpchi",
  aion: "GAC Aion",
  mg: "MG",
  wuling: "Wuling",
  baojun: "Baojun",
  bestune: "Bestune",
  dongfeng: "Dongfeng",
  roewe: "Roewe",
};

const MODEL_SEARCH_OVERRIDES: Record<string, string> = {
  "vehicle-audi-a3": "A3 8Y",
  "vehicle-audi-a4": "A4 B9",
  "vehicle-audi-a6": "A6 C8",
  "vehicle-audi-a8l": "A8L D5",
  "vehicle-audi-q5": "Q5 FY",
  "vehicle-audi-q6": "Q6 03 China",
  "vehicle-audi-r8": "R8 Coupe",
  "vehicle-audi-rs4": "RS4 Avant B9",
  "vehicle-audi-rs5": "RS5 Coupe F5",
  "vehicle-audi-rs6": "RS6 Avant C8",
  "vehicle-audi-rs7": "RS7 C8",
  "vehicle-audi-s3": "S3 Sedan",
  "vehicle-audi-s4": "S4 B9",
  "vehicle-audi-s5": "S5 Sportback F5",
  "vehicle-audi-s6": "S6 C8",
  "vehicle-audi-s7": "S7 C8",
  "vehicle-bmw-1": "1 SERIES SEDAN (F52) China",
  "vehicle-bmw-2": "2-Series F44 Gran Coupe",
  "vehicle-bmw-4": "4 SERIES GRAN COUPE G26 China",
  "vehicle-bmw-7": "7-Series G70",
  "vehicle-bmw-8": "8 SERIES GRAN COUPE (G15) China",
  "vehicle-bmw-i3": "i3 G28",
  "vehicle-bmw-m3": "M3 G80",
  "vehicle-bmw-x5": "X5 G05",
  "vehicle-bmw-x6": "X6 G06",
  "vehicle-mercedes-b": "B-CLASS (W246) China",
  "vehicle-mercedes-cla": "CLA 200",
  "vehicle-mercedes-g": "G-CLASS (W463) China",
  "vehicle-mercedes-glb": "GLB China",
  "vehicle-mercedes-sl": "SL 55",
  "vehicle-mercedes-vito": "Vito Tourer W447",
  "vehicle-tesla-model-yl": "Model Y L",
  "vehicle-volkswagen-beetle": "Beetle A5",
  "vehicle-volkswagen-bora": "Bora CN III",
  "vehicle-volkswagen-cc": "CC II",
  "vehicle-volkswagen-golf": "Golf VIII",
  "vehicle-volkswagen-id4-crozz": "ID.4 Crozz",
  "vehicle-volkswagen-id6-crozz": "ID.6 Crozz",
  "vehicle-volkswagen-id6x": "ID.6 X",
  "vehicle-volkswagen-id7-vizzion": "ID.7 Vizzion",
  "vehicle-volkswagen-caravelle": "T6 Caravelle",
  "vehicle-volkswagen-multivan": "T6.1 Multivan",
  "vehicle-volkswagen-passat": "Passat NMS",
  "vehicle-volkswagen-t-roc": "T-Roc China",
  "vehicle-volkswagen-tiguan": "Tiguan III",
  "vehicle-volkswagen-variant": "Passat Variant B8",
  "vehicle-toyota-allion": "Allion E210",
  "vehicle-toyota-avalon": "Avalon XX50",
  "vehicle-toyota-alphard": "Alphard AH40",
  "vehicle-toyota-86": "86 GT",
  "vehicle-toyota-c-hr": "C-HR AX10",
  "vehicle-toyota-corolla": "Corolla E210 Sedan",
  "vehicle-toyota-hiace": "Hiace H300",
  "vehicle-toyota-izoa": "Izoa 01 China",
  "vehicle-toyota-land-cruiser": "Land Cruiser 300",
  "vehicle-toyota-levin": "Levin E210",
  "vehicle-toyota-ling-shang": "Levin GT",
  "vehicle-toyota-prado": "Land Cruiser Prado J250",
  "vehicle-toyota-previa": "Previa XR50 China",
  "vehicle-toyota-sequoia": "Sequoia XK80",
  "vehicle-toyota-sienna": "Sienna XL40",
  "vehicle-toyota-supra": "Supra J29",
  "vehicle-toyota-vellfire": "Vellfire AH40",
  "vehicle-toyota-vios": "Vios XP150 China",
  "vehicle-toyota-wildlander": "Wildlander XA50",
  "vehicle-toyota-yaris": "Yaris XP90 China",
  "vehicle-toyota-yaris-l": "Yaris L hatch facelift",
  "vehicle-toyota-yaris-l-sedan": "Yaris L sedan",
};

const FULL_QUERY_OVERRIDES: Record<string, string> = {
  "vehicle-li-one": "Lixiang ONE",
  "vehicle-toyota-granvia": "TOYOTA GRANVIA (XL40)",
  "vehicle-volkswagen-caravelle": "Volkswagen Caravelle n°313",
};

function stripTags(value: string | undefined) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalized(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function modelSearchName(entry: CatalogEntry) {
  if (MODEL_SEARCH_OVERRIDES[entry.modelId]) return MODEL_SEARCH_OVERRIDES[entry.modelId];
  if (entry.brandId === "brand-mercedes" && /^[a-z]$/i.test(entry.modelSlug)) {
    return `${entry.modelSlug.toUpperCase()}-Class`;
  }
  if (entry.brandId === "brand-bmw" && /^\d$/.test(entry.modelSlug)) {
    return `${entry.modelSlug} Series`;
  }
  return entry.modelSlug.replaceAll("-", " ");
}

function confidenceAliases(entry: CatalogEntry) {
  const aliases = new Set<string>();
  const slug = normalized(entry.modelSlug);
  const display = normalized(entry.modelName);
  if (slug.length >= 2) aliases.add(slug);
  if (display.length >= 2) aliases.add(display);
  aliases.add(normalized(modelSearchName(entry)));
  return [...aliases].filter((alias) => alias.length >= 2);
}

function brandAliases(entry: CatalogEntry) {
  const seed = entry.brandId.replace(/^brand-/, "");
  const searchName = BRAND_SEARCH_NAMES[seed] ?? seed.replaceAll("-", " ");
  return [normalized(searchName), normalized(seed)].filter((value, index, values) => value && values.indexOf(value) === index);
}

const candidates: CatalogEntry[] = VEHICLE_CATALOG.flatMap((brand) => brand.models.map((model) => ({
  modelId: model.id,
  brandId: brand.id,
  brandName: brand.name,
  modelName: model.name,
  modelSlug: model.id.slice(`vehicle-${brand.id.replace(/^brand-/, "")}-`.length),
  vehicleClassCodes: model.vehicleClassCodes,
}))).filter((entry) => {
  const model = VEHICLE_CATALOG.find((brand) => brand.id === entry.brandId)?.models.find((item) => item.id === entry.modelId);
  return !model?.imageUrl && entry.vehicleClassCodes.includes("passenger_car");
});

const selected = modelId
  ? candidates.filter((entry) => entry.modelId === modelId)
  : candidates.slice(offset, offset + limit);
if (modelId && selected.length !== 1) throw new Error(`Unknown or already-approved Commons candidate: ${modelId}`);

const existing = await readFile(outputUrl, "utf8")
  .then((value) => JSON.parse(value) as { entries?: ProbeEntry[] })
  .catch(() => ({ entries: [] }));
const byId = new Map((existing.entries ?? []).map((entry) => [entry.modelId, entry] as const));

async function probe(entry: CatalogEntry): Promise<ProbeEntry> {
  const brandSeed = entry.brandId.replace(/^brand-/, "");
  const brand = BRAND_SEARCH_NAMES[brandSeed] ?? brandSeed.replaceAll("-", " ");
  const query = FULL_QUERY_OVERRIDES[entry.modelId] ?? `${brand} ${modelSearchName(entry)}`;
  const checkedAt = new Date().toISOString();
  try {
    const api = new URL("https://commons.wikimedia.org/w/api.php");
    api.searchParams.set("action", "query");
    api.searchParams.set("generator", "search");
    api.searchParams.set("gsrsearch", `intitle:\"${query}\"`);
    api.searchParams.set("gsrnamespace", "6");
    api.searchParams.set("gsrlimit", "12");
    api.searchParams.set("prop", "imageinfo");
    api.searchParams.set("iiprop", "url|size|mime|extmetadata");
    api.searchParams.set("iiurlwidth", "1200");
    api.searchParams.set("format", "json");
    api.searchParams.set("formatversion", "2");
    api.searchParams.set("origin", "*");
    let response: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(api, {
        headers: { "user-agent": "YuxiaomanVehicleCatalog/1.0 (licensed asset candidate audit)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 429) break;
      await response.body?.cancel();
      const retryAfterSeconds = Number(response.headers.get("retry-after") ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfterSeconds * 1_000, 1_500 * (attempt + 1))));
    }
    if (!response) throw new Error("Commons request did not start");
    if (!response.ok) throw new Error(`Commons HTTP ${response.status}`);
    const body = await response.json() as { query?: { pages?: CommonsPage[] } };
    const brandNeedles = brandAliases(entry);
    const modelNeedles = confidenceAliases(entry);
    const found = (body.query?.pages ?? []).flatMap((page): CommonsCandidate[] => {
      const info = page.imageinfo?.[0];
      if (!page.pageid || !page.title || !info?.url) return [];
      const metadata = info.extmetadata ?? {};
      const title = normalized(page.title.replace(/^File:/i, ""));
      const highConfidenceTitleMatch = brandNeedles.some((needle) => title.includes(needle))
        && modelNeedles.some((needle) => title.includes(needle));
      return [{
        pageId: page.pageid,
        title: page.title,
        sourcePageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/?curid=${page.pageid}`,
        originalUrl: info.url,
        thumbUrl: info.thumburl ?? info.url,
        width: Number(info.width ?? 0),
        height: Number(info.height ?? 0),
        mime: info.mime ?? "",
        license: stripTags(metadata.LicenseShortName?.value),
        licenseUrl: stripTags(metadata.LicenseUrl?.value),
        author: stripTags(metadata.Artist?.value),
        credit: stripTags(metadata.Credit?.value),
        description: stripTags(metadata.ImageDescription?.value || metadata.ObjectName?.value),
        highConfidenceTitleMatch,
      }];
    }).sort((left, right) => Number(right.highConfidenceTitleMatch) - Number(left.highConfidenceTitleMatch));
    return {
      ...entry,
      query,
      checkedAt,
      status: found.some((item) => item.highConfidenceTitleMatch)
        ? "high_confidence_candidate"
        : found.length ? "review_candidates" : "no_candidate",
      candidates: found,
      error: "",
    };
  } catch (error) {
    return {
      ...entry,
      query,
      checkedAt,
      status: "request_failed",
      candidates: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

for (let index = 0; index < selected.length; index += concurrency) {
  const batch = await Promise.all(selected.slice(index, index + concurrency).map(probe));
  for (const result of batch) {
    byId.set(result.modelId, result);
    console.log(`${result.modelId}: ${result.status} (${result.candidates.length})`);
  }
}

const entries = [...byId.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  provider: "Wikimedia Commons API",
  rule: "A title match only nominates a licensed reference candidate. Visual exact-series review is mandatory before generation or publication.",
  summary: {
    probed: entries.length,
    highConfidenceCandidates: entries.filter((entry) => entry.status === "high_confidence_candidate").length,
    reviewCandidates: entries.filter((entry) => entry.status === "review_candidates").length,
    noCandidate: entries.filter((entry) => entry.status === "no_candidate").length,
    requestFailed: entries.filter((entry) => entry.status === "request_failed").length,
  },
  entries,
};
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report.summary));
