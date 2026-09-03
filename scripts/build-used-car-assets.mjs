import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import {
  USED_CAR_IMAGE_LISTINGS,
  USED_CAR_IMAGE_MODELS,
  validateUsedCarImageManifest,
} from "./used-car-image-manifest.mjs";

const projectRoot = process.cwd();
const assetRoot = path.join(projectRoot, "public", "assets", "used-cars");
const listingsRoot = path.join(assetRoot, "listings");
const modelsRoot = path.join(assetRoot, "models");
const supportedExtensions = ["webp", "jpg", "jpeg", "png"];

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const sourceRoots = [];
const sourceManifestPaths = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== "--source-root" && args[index] !== "--source-manifest") continue;
  const option = args[index];
  if (!args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`${option} requires a path`);
  }
  if (option === "--source-root") {
    sourceRoots.push(path.resolve(projectRoot, args[index + 1]));
  } else {
    sourceManifestPaths.push(path.resolve(projectRoot, args[index + 1]));
  }
  index += 1;
}
if (sourceRoots.length === 0) {
  sourceRoots.push(path.join(assetRoot, "real-sources"));
}

const fileExists = async (filePath) => {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

async function firstExistingImage(basePaths) {
  for (const basePath of basePaths) {
    for (const extension of supportedExtensions) {
      const candidate = `${basePath}.${extension}`;
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

async function loadDeclaredModelSources() {
  const declaredSources = new Map();
  const validModelIds = new Set(USED_CAR_IMAGE_MODELS.map((model) => model.modelId));
  for (const manifestPath of sourceManifestPaths) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!Array.isArray(manifest.entries)) {
      throw new Error(`Source manifest has no entries array: ${manifestPath}`);
    }
    for (const entry of manifest.entries) {
      if (!entry.modelId || !entry.localFile) {
        throw new Error(`Every source entry needs exact modelId and localFile: ${manifestPath}`);
      }
      if (!validModelIds.has(entry.modelId)) {
        throw new Error(`Unknown modelId ${entry.modelId} in ${manifestPath}`);
      }
      if (declaredSources.has(entry.modelId)) {
        throw new Error(`Duplicate declared source for ${entry.modelId}`);
      }
      declaredSources.set(entry.modelId, path.resolve(projectRoot, entry.localFile));
    }
  }
  return declaredSources;
}

function sourceCandidatesForModel(modelId) {
  return sourceRoots.flatMap((sourceRoot) => [
    path.join(sourceRoot, "models", modelId, "cover"),
    path.join(sourceRoot, "models", modelId),
    path.join(sourceRoot, modelId, "cover"),
    path.join(sourceRoot, modelId),
  ]);
}

function sourceCandidatesForListing(listingId, imageSequence) {
  return sourceRoots.flatMap((sourceRoot) => [
    path.join(sourceRoot, "listings", listingId, imageSequence),
    path.join(sourceRoot, listingId, imageSequence),
  ]);
}

async function validateSeedIdentityMapping() {
  const seedPath = path.join(projectRoot, "server", "used-car-db.ts");
  const seedSource = await fs.readFile(seedPath, "utf8");
  const modelBlockStart = seedSource.indexOf("const DEMO_MODELS");
  const listingBlockStart = seedSource.indexOf("const DEMO_LISTINGS");
  const listingBlockEnd = seedSource.indexOf("function assertDemoDataInvariants");
  if (modelBlockStart < 0 || listingBlockStart < 0 || listingBlockEnd < 0) {
    throw new Error("Unable to locate the used-car model/listing seed blocks");
  }

  const modelBlock = seedSource.slice(modelBlockStart, listingBlockStart);
  const seedModelIds = [
    ...modelBlock.matchAll(/id:\s*(?:"(model-[^"]+)"|USED_CAR_MODEL_IDS\.liL7)/g),
  ].map((match) => match[1] ?? "model-li-l7");
  const manifestModelIds = USED_CAR_IMAGE_MODELS.map((model) => model.modelId);
  if (
    seedModelIds.length !== manifestModelIds.length
    || seedModelIds.some((modelId) => !manifestModelIds.includes(modelId))
  ) {
    throw new Error("Image manifest model ids no longer match server/used-car-db.ts");
  }

  const listingBlock = seedSource.slice(listingBlockStart, listingBlockEnd);
  const seedListingModelIds = [
    ...listingBlock.matchAll(/modelId:\s*(?:"(model-[^"]+)"|USED_CAR_MODEL_IDS\.liL7)/g),
  ].map((match) => match[1] ?? "model-li-l7");
  if (seedListingModelIds.length !== USED_CAR_IMAGE_LISTINGS.length) {
    throw new Error(
      `Expected ${USED_CAR_IMAGE_LISTINGS.length} seeded listing/model links, found ${seedListingModelIds.length}`,
    );
  }
  for (const [index, listing] of USED_CAR_IMAGE_LISTINGS.entries()) {
    if (listing.modelId !== seedListingModelIds[index]) {
      throw new Error(
        `${listing.listingId} must map to ${seedListingModelIds[index]}, not ${listing.modelId}`,
      );
    }
  }
}

async function validateImage(filePath, identity) {
  try {
    const metadata = await sharp(filePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("image has no readable dimensions");
    }
    if (metadata.width < 600 || metadata.height < 400) {
      throw new Error(`image is too small (${metadata.width}x${metadata.height}; minimum 600x400)`);
    }
  } catch (error) {
    throw new Error(`Invalid source image for ${identity}: ${filePath}\n${error.message}`);
  }
}

validateUsedCarImageManifest();
await validateSeedIdentityMapping();
const declaredModelSources = await loadDeclaredModelSources();

// Resolve every required model photo before writing anything. This prevents a
// partial rebuild and makes an absent or misnamed model image fail visibly.
const modelSources = new Map();
const missingModels = [];
for (const model of USED_CAR_IMAGE_MODELS) {
  const declaredSource = declaredModelSources.get(model.modelId);
  const source = declaredSource
    ? (await fileExists(declaredSource) ? declaredSource : null)
    : await firstExistingImage(sourceCandidatesForModel(model.modelId));
  if (!source) {
    missingModels.push(
      declaredSource
        ? `${model.modelId} (${model.displayName}); declared file missing: ${declaredSource}`
        : `${model.modelId} (${model.displayName})`,
    );
    continue;
  }
  await validateImage(source, `${model.modelId} (${model.displayName})`);
  modelSources.set(model.modelId, source);
}

if (missingModels.length > 0) {
  throw new Error(
    [
      `Missing ${missingModels.length} exact-model source image(s). Searched:`,
      ...sourceRoots.map((sourceRoot) => `- source root: ${sourceRoot}`),
      ...sourceManifestPaths.map((manifestPath) => `- source manifest: ${manifestPath}`),
      ...missingModels.map((model) => `- ${model}`),
      "Expected: models/<modelId>/cover.(webp|jpg|jpeg|png) or models/<modelId>.<ext>",
      "No output files were changed.",
    ].join("\n"),
  );
}

const listingSources = new Map();
let listingSpecificCoverCount = 0;
let listingSpecificAlternateCount = 0;
for (const listing of USED_CAR_IMAGE_LISTINGS) {
  const modelSource = modelSources.get(listing.modelId);
  const coverOverride = await firstExistingImage(
    sourceCandidatesForListing(listing.listingId, "01"),
  );
  const alternateOverride = await firstExistingImage(
    sourceCandidatesForListing(listing.listingId, "02"),
  );
  if (coverOverride) {
    await validateImage(coverOverride, `${listing.listingId} cover (${listing.displayName})`);
    listingSpecificCoverCount += 1;
  }
  if (alternateOverride) {
    await validateImage(alternateOverride, `${listing.listingId} alternate (${listing.displayName})`);
    listingSpecificAlternateCount += 1;
  }
  listingSources.set(listing.listingId, {
    cover: coverOverride ?? modelSource,
    alternate: alternateOverride ?? coverOverride ?? modelSource,
  });
}

if (checkOnly) {
  console.log(
    `Validated ${modelSources.size} exact-model sources and ${USED_CAR_IMAGE_LISTINGS.length} listing mappings.`,
  );
  console.log(
    `Listing-specific overrides: ${listingSpecificCoverCount} covers, ${listingSpecificAlternateCount} alternates.`,
  );
  process.exit(0);
}

await fs.mkdir(listingsRoot, { recursive: true });
await fs.mkdir(modelsRoot, { recursive: true });

for (const model of USED_CAR_IMAGE_MODELS) {
  await sharp(modelSources.get(model.modelId))
    .rotate()
    .resize(960, 720, { fit: "cover" })
    .webp({ quality: 84 })
    .toFile(path.join(modelsRoot, `${model.modelId}.webp`));
}

for (const listing of USED_CAR_IMAGE_LISTINGS) {
  const targetRoot = path.join(listingsRoot, listing.listingId);
  const sources = listingSources.get(listing.listingId);
  await fs.mkdir(targetRoot, { recursive: true });
  await Promise.all([
    sharp(sources.cover)
      .rotate()
      .resize(1440, 1080, { fit: "cover" })
      .webp({ quality: 86 })
      .toFile(path.join(targetRoot, "01.webp")),
    sharp(sources.alternate)
      .rotate()
      .resize(1440, 1080, { fit: "cover" })
      .webp({ quality: 86 })
      .toFile(path.join(targetRoot, "02.webp")),
  ]);
}

console.log(
  `Built ${USED_CAR_IMAGE_MODELS.length} exact-model covers and ${USED_CAR_IMAGE_LISTINGS.length * 2} listing images in ${assetRoot}`,
);
console.log(
  `Listing-specific overrides: ${listingSpecificCoverCount} covers, ${listingSpecificAlternateCount} alternates; remaining listing frames inherit only their exact model source.`,
);
