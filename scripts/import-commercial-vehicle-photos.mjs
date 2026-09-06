import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const optimizedRoot = path.join(projectRoot, "public/assets/used-cars/owner-model-photos");
const sourceRoot = path.join(projectRoot, "public/assets/used-cars/real-sources/owner-models");
const manifestPath = path.join(projectRoot, "references/commercial-vehicle-real-photo-sources.json");

const sources = [
  ["vehicle-yutong-bus-zk6126hg", "宇通客车 ZK6126HG", "File:Yutong ZK6126HG, Almaty (P1180157).jpg"],
  ["vehicle-faw-jiefang-j7", "一汽解放 J7", "File:20220709 Jiefang J7 truck on Shangdu Road.jpg"],
  ["vehicle-dongfeng-commercial-tianlong-kl", "东风商用车 天龙KL", "File:Dongfeng Tianlong KL IMG001.jpg"],
  ["vehicle-dongfeng-commercial-tianjin-kr", "东风商用车 天锦KR", "File:Dongfeng Tianjin KR 001.jpg"],
  ["vehicle-sinotruk-howo-howo", "中国重汽豪沃 HOWO", "File:Sinotruk Howo Truck.jpg"],
  ["vehicle-sinotruk-howo-a7", "中国重汽豪沃 HOWO A7", "File:HOWO A7 SINOTRUK Prime Mover 0325.jpg"],
  ["vehicle-sinotruk-howo-hanjiang", "中国重汽豪沃 悍将", "File:Sinotruk Howo Hanjiang flatbed 001.jpg"],
  ["vehicle-shacman-x6000", "陕汽重卡 X6000", "File:Moscow, Sushchyovsky Val 63, Shacman X6000, May 2026 01.jpg"],
  ["vehicle-shacman-x3000", "陕汽重卡 X3000", "File:Shacman X3000 (53512619610).jpg"],
  ["vehicle-foton-auman-gtl", "福田欧曼 GTL", "File:20220102 Foton Auman GTL refrigerated truck.jpg"],
  ["vehicle-foton-auman-etx", "福田欧曼 ETX", "File:Foton Auman ETX.jpg"],
  ["vehicle-jac-shuailing-n55", "江淮帅铃 N55", "File:JAC N55, SHUAILING.jpg"],
  ["vehicle-jac-shuailing-shuailing-ii", "江淮帅铃 II", "File:JAC Shuailing II box truck medical waste unit, front 8.8.18.jpg"],
  ["vehicle-trailer-body-flatbed", "平板半挂车", "File:Flatbed semi-trailer truck, Russia.jpg"],
  ["vehicle-trailer-body-drop-side", "栏板半挂车", "File:Drop side semi-trailer.jpg"],
  ["vehicle-trailer-body-car-carrier", "车辆运输半挂车", "File:Chinese car transporter.jpg"],
  ["vehicle-trailer-body-curtain-side", "侧帘半挂车", "File:WieltonCurtainSider.jpg"],
  ["vehicle-trailer-body-container", "集装箱运输半挂车", "File:Cosco Shipping container semi-trailer.jpg"],
  ["vehicle-trailer-body-tanker", "罐式半挂车", "File:Tanker semi-trailer hauling crude oil.jpg"],
  ["vehicle-trailer-body-box", "厢式半挂车", "File:Premier Trailer leasing semi-trailer.jpg"],
];

function plainText(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithRetry(url, sourceTitle) {
  const retryDelays = [0, 3_000, 8_000, 15_000];
  let lastStatus = 0;
  for (const delay of retryDelays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const response = await fetch(url, { headers: { "user-agent": "YuxiaomanVehicleCatalog/1.0 (asset import)" } });
    if (response.ok) return response;
    lastStatus = response.status;
    if (response.status !== 429 && response.status < 500) break;
  }
  throw new Error(`Commons image download failed (${lastStatus}): ${sourceTitle}`);
}

await mkdir(optimizedRoot, { recursive: true });
await mkdir(path.dirname(manifestPath), { recursive: true });

const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
apiUrl.search = new URLSearchParams({
  action: "query",
  format: "json",
  formatversion: "2",
  prop: "imageinfo",
  iiprop: "url|size|mime|extmetadata",
  iiurlwidth: "1600",
  titles: sources.map(([, , title]) => title).join("|"),
}).toString();
const apiResponse = await fetch(apiUrl, { headers: { "user-agent": "YuxiaomanVehicleCatalog/1.0 (asset import)" } });
if (!apiResponse.ok) throw new Error(`Commons metadata request failed: ${apiResponse.status}`);
const metadata = await apiResponse.json();
const pagesByTitle = new Map(metadata.query.pages.map((page) => [page.title, page]));
const manifestSources = [];
const optimizedHashes = new Set();

for (const [modelId, displayName, sourceTitle] of sources) {
  const page = pagesByTitle.get(sourceTitle);
  const image = page?.imageinfo?.[0];
  if (!image?.thumburl || !image?.descriptionurl) throw new Error(`Commons image is missing: ${sourceTitle}`);
  const sourceDirectory = path.join(sourceRoot, modelId);
  const sourcePath = path.join(sourceDirectory, "cover.webp");
  const optimizedPath = path.join(optimizedRoot, `${modelId}.webp`);
  await mkdir(sourceDirectory, { recursive: true });
  let sourceBuffer;
  let optimizedBuffer;
  try {
    [sourceBuffer, optimizedBuffer] = await Promise.all([readFile(sourcePath), readFile(optimizedPath)]);
  } catch {
    const response = await fetchWithRetry(image.thumburl, sourceTitle);
    const input = Buffer.from(await response.arrayBuffer());
    sourceBuffer = await sharp(input).rotate().resize(1600, 900, {
      fit: "contain",
      background: "#edf2f5",
    }).webp({ quality: 88 }).toBuffer();
    optimizedBuffer = await sharp(sourceBuffer).resize(720, 405, {
      fit: "fill",
    }).webp({ quality: 78 }).toBuffer();
    await writeFile(sourcePath, sourceBuffer);
    await writeFile(optimizedPath, optimizedBuffer);
  }
  const hash = createHash("sha256").update(optimizedBuffer).digest("hex");
  if (optimizedHashes.has(hash)) throw new Error(`Duplicate optimized commercial image: ${modelId}`);
  optimizedHashes.add(hash);
  const ext = image.extmetadata || {};
  manifestSources.push({
    modelId,
    displayName,
    identityScope: modelId.startsWith("vehicle-trailer-body-")
      ? "vehicle_body_form_reference"
      : "series_reference_not_specific_model_year",
    sourceTitle,
    sourcePageUrl: image.descriptionurl,
    originalUrl: image.url,
    originalDimensions: { width: image.width, height: image.height },
    author: plainText(ext.Artist?.value),
    credit: plainText(ext.Credit?.value),
    license: plainText(ext.LicenseShortName?.value),
    licenseUrl: ext.LicenseUrl?.value || "",
    description: plainText(ext.ImageDescription?.value),
    localSource: `public/assets/used-cars/real-sources/owner-models/${modelId}/cover.webp`,
    optimizedAsset: `public/assets/used-cars/owner-model-photos/${modelId}.webp`,
  });
}

await writeFile(manifestPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-09-05",
  purpose: "Traceable real-series and vehicle-body-form photos for owner commercial-vehicle selection.",
  selectionPolicy: "Every truck and bus image is tied to the named series. Trailer images identify the selected body form. Images do not claim a model year, trim, axle configuration, color or the owner's exact vehicle.",
  runtimePolicy: "Optimized assets are served by the API and loaded lazily. No passenger-car or generic truck image is reused as a commercial model image.",
  sources: manifestSources,
}, null, 2)}\n`, "utf8");

console.log(`Imported ${manifestSources.length} distinct commercial-vehicle reference photos.`);
