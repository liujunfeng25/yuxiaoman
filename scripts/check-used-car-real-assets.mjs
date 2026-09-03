import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  USED_CAR_IMAGE_LISTINGS,
  USED_CAR_IMAGE_MODELS,
  validateUsedCarImageManifest,
} from "./used-car-image-manifest.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = path.join(projectRoot, "public", "assets", "used-cars");
const referencesRoot = path.join(projectRoot, "references");
const expectedManifestNames = [
  "used-car-real-photo-sources-global.json",
  "used-car-real-photo-sources-china.json",
];
const permanentSourceRoot = path.join(assetRoot, "real-sources");
const supportedSourceExtensions = ["webp", "jpg", "jpeg", "png"];

function describeValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function assertNonEmptyString(value, fieldName, identity) {
  assert.equal(
    typeof value,
    "string",
    `${identity}.${fieldName} must be a non-empty string; got ${describeValue(value)}`,
  );
  assert.ok(value.trim(), `${identity}.${fieldName} must not be blank`);
}

function assertHttpUrl(value, fieldName, identity) {
  assertNonEmptyString(value, fieldName, identity);
  const parsed = new URL(value);
  assert.ok(
    parsed.protocol === "https:" || parsed.protocol === "http:",
    `${identity}.${fieldName} must use HTTP(S)`,
  );
}

function assertLicense(license, identity) {
  assert.ok(license, `${identity}.license is required`);
  if (typeof license === "string") {
    assert.ok(license.trim(), `${identity}.license must not be blank`);
    return;
  }
  assert.equal(typeof license, "object", `${identity}.license must be a string or object`);
  const label = license.name ?? license.spdx;
  assertNonEmptyString(label, "license.name/license.spdx", identity);
  if (license.url !== undefined) {
    assertHttpUrl(license.url, "license.url", identity);
  }
}

async function readSourceRecords() {
  const entries = [];
  const listingSpecific = [];
  for (const manifestName of expectedManifestNames) {
    const manifestPath = path.join(referencesRoot, manifestName);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.ok(Array.isArray(manifest.entries), `${manifestName} must contain an entries array`);
    for (const [index, entry] of manifest.entries.entries()) {
      entries.push({ ...entry, manifestName, manifestIndex: index });
    }
    if (manifest.listingSpecific !== undefined) {
      assert.ok(
        Array.isArray(manifest.listingSpecific),
        `${manifestName}.listingSpecific must be an array when provided`,
      );
      for (const [index, entry] of manifest.listingSpecific.entries()) {
        listingSpecific.push({ ...entry, manifestName, manifestIndex: index });
      }
    }
  }
  return { entries, listingSpecific };
}

function validateSourceCoverage(entries) {
  const expectedModelIds = new Set(USED_CAR_IMAGE_MODELS.map((model) => model.modelId));
  const entriesByModelId = new Map();
  const sourcePages = new Set();

  for (const entry of entries) {
    const identity = `${entry.manifestName}.entries[${entry.manifestIndex}]`;
    assertNonEmptyString(entry.modelId, "modelId", identity);
    assert.ok(expectedModelIds.has(entry.modelId), `${identity} has unknown modelId ${entry.modelId}`);
    assert.ok(!entriesByModelId.has(entry.modelId), `duplicate source entry for ${entry.modelId}`);
    assertNonEmptyString(entry.localFile, "localFile", identity);
    assertHttpUrl(entry.sourcePage, "sourcePage", identity);
    assertNonEmptyString(entry.author, "author", identity);
    assertLicense(entry.license, identity);
    assert.ok(!sourcePages.has(entry.sourcePage), `sourcePage is reused by multiple models: ${entry.sourcePage}`);
    sourcePages.add(entry.sourcePage);
    entriesByModelId.set(entry.modelId, entry);
  }

  assert.equal(entriesByModelId.size, 46, `source manifests must cover 46 models; found ${entriesByModelId.size}`);
  for (const modelId of expectedModelIds) {
    assert.ok(entriesByModelId.has(modelId), `source manifests are missing ${modelId}`);
  }

  return entriesByModelId;
}

function validateListingSourceRecords(records) {
  const expectedListingModels = new Map(
    USED_CAR_IMAGE_LISTINGS.map((listing) => [listing.listingId, listing.modelId]),
  );
  const recordsByListingFrame = new Map();

  for (const record of records) {
    const identity = `${record.manifestName}.listingSpecific[${record.manifestIndex}]`;
    assertNonEmptyString(record.listingId, "listingId", identity);
    assertNonEmptyString(record.modelId, "modelId", identity);
    assert.ok(expectedListingModels.has(record.listingId), `${identity} has unknown listingId ${record.listingId}`);
    assert.equal(
      record.modelId,
      expectedListingModels.get(record.listingId),
      `${identity}.modelId must equal the seeded modelId for ${record.listingId}`,
    );
    assert.ok(record.imageOrder === 1 || record.imageOrder === 2, `${identity}.imageOrder must be 1 or 2`);
    assertNonEmptyString(record.localFile, "localFile", identity);
    assertHttpUrl(record.sourcePage, "sourcePage", identity);
    assertNonEmptyString(record.author, "author", identity);
    assertLicense(record.license, identity);

    const frame = `${record.listingId}/${String(record.imageOrder).padStart(2, "0")}`;
    assert.ok(!recordsByListingFrame.has(frame), `duplicate listing-specific source record for ${frame}`);
    recordsByListingFrame.set(frame, record);
  }

  return recordsByListingFrame;
}

async function assertFileMatches(actualPath, expectedBuffer, identity) {
  const actualBuffer = await fs.readFile(actualPath);
  assert.ok(
    actualBuffer.equals(expectedBuffer),
    `${identity} was not built from its declared exact-model source`,
  );
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function firstExistingSource(basePaths) {
  for (const basePath of basePaths) {
    for (const extension of supportedSourceExtensions) {
      const candidate = `${basePath}.${extension}`;
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

async function validateSourceImage(sourcePath, identity) {
  let metadata;
  try {
    metadata = await sharp(sourcePath, { failOn: "error" }).metadata();
  } catch (error) {
    throw new Error(`${identity} is missing or invalid: ${sourcePath}\n${error.message}`);
  }
  assert.ok(metadata.width && metadata.height, `${identity} has no readable dimensions`);
  assert.ok(
    metadata.width >= 600 && metadata.height >= 400,
    `${identity} is too small (${metadata.width}x${metadata.height})`,
  );
}

async function validateOutputsMatchDeclaredSources(entriesByModelId, listingRecordsByFrame) {
  const sourcePathByModelId = new Map();
  const listingOutputBySourcePath = new Map();

  // Re-run the deterministic Sharp transforms in memory. A byte-for-byte match
  // proves that an old synthetic or position-based image was not left behind.
  for (const model of USED_CAR_IMAGE_MODELS) {
    const entry = entriesByModelId.get(model.modelId);
    const sourcePath = path.resolve(projectRoot, entry.localFile);
    await validateSourceImage(sourcePath, `declared source for ${model.modelId}`);
    sourcePathByModelId.set(model.modelId, sourcePath);

    const expectedModelOutput = await sharp(sourcePath)
      .rotate()
      .resize(960, 720, { fit: "cover" })
      .webp({ quality: 84 })
      .toBuffer();
    await assertFileMatches(
      path.join(assetRoot, "models", `${model.modelId}.webp`),
      expectedModelOutput,
      `model output ${model.modelId}`,
    );
  }

  for (const listing of USED_CAR_IMAGE_LISTINGS) {
    const modelSource = sourcePathByModelId.get(listing.modelId);
    assert.ok(modelSource, `no declared model source for ${listing.listingId}/${listing.modelId}`);
    const listingSourceBases = (sequence) => [
      path.join(permanentSourceRoot, "listings", listing.listingId, sequence),
      path.join(permanentSourceRoot, listing.listingId, sequence),
    ];
    const coverOverride = await firstExistingSource(listingSourceBases("01"));
    const alternateOverride = await firstExistingSource(listingSourceBases("02"));
    const sources = {
      "01": coverOverride ?? modelSource,
      "02": alternateOverride ?? coverOverride ?? modelSource,
    };

    for (const sequence of ["01", "02"]) {
      const sourcePath = sources[sequence];
      const sourceOverride = sequence === "01" ? coverOverride : alternateOverride;
      if (sourceOverride) {
        const frame = `${listing.listingId}/${sequence}`;
        const sourceRecord = listingRecordsByFrame.get(frame);
        assert.ok(sourceRecord, `listing-specific source ${frame} is missing provenance metadata`);
        assert.equal(
          path.resolve(projectRoot, sourceRecord.localFile).toLowerCase(),
          sourceOverride.toLowerCase(),
          `${frame} provenance localFile must resolve to the selected listing source`,
        );
      }
      await validateSourceImage(
        sourcePath,
        `source for ${listing.listingId}/${sequence} (${listing.modelId})`,
      );
      let expectedListingOutput = listingOutputBySourcePath.get(sourcePath);
      if (!expectedListingOutput) {
        expectedListingOutput = await sharp(sourcePath)
          .rotate()
          .resize(1440, 1080, { fit: "cover" })
          .webp({ quality: 86 })
          .toBuffer();
        listingOutputBySourcePath.set(sourcePath, expectedListingOutput);
      }
      await assertFileMatches(
        path.join(assetRoot, "listings", listing.listingId, `${sequence}.webp`),
        expectedListingOutput,
        `listing output ${listing.listingId}/${sequence} (${listing.modelId})`,
      );
    }
  }

  for (const [frame, sourceRecord] of listingRecordsByFrame) {
    const sourcePath = path.resolve(projectRoot, sourceRecord.localFile);
    assert.ok(await fileExists(sourcePath), `listing-specific provenance ${frame} points to a missing file`);
  }
}

async function decodeAndValidateImage(filePath, expected, identity) {
  let metadata;
  try {
    metadata = await sharp(filePath, { failOn: "error" }).metadata();
    // metadata() alone may accept a truncated file. Force a full pixel decode too.
    await sharp(filePath, { failOn: "error" }).raw().toBuffer();
  } catch (error) {
    throw new Error(`${identity} is missing or cannot be fully decoded: ${filePath}\n${error.message}`);
  }

  assert.equal(metadata.format, "webp", `${identity} must be WebP; got ${metadata.format}`);
  assert.equal(metadata.width, expected.width, `${identity} width must be ${expected.width}`);
  assert.equal(metadata.height, expected.height, `${identity} height must be ${expected.height}`);
}

async function validateOutputSets() {
  const expectedModelNames = USED_CAR_IMAGE_MODELS
    .map((model) => `${model.modelId}.webp`)
    .sort();
  const actualModelNames = (await fs.readdir(path.join(assetRoot, "models"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".webp"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actualModelNames, expectedModelNames, "model output set must contain exactly 46 expected WebP files");

  const expectedListingNames = USED_CAR_IMAGE_LISTINGS.map((listing) => listing.listingId).sort();
  const actualListingNames = (await fs.readdir(path.join(assetRoot, "listings"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("used-car-listing-"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actualListingNames, expectedListingNames, "listing output set must contain exactly 30 expected directories");

  await Promise.all([
    ...USED_CAR_IMAGE_MODELS.map((model) =>
      decodeAndValidateImage(
        path.join(assetRoot, "models", `${model.modelId}.webp`),
        { width: 960, height: 720 },
        `model output ${model.modelId}`,
      )),
    ...USED_CAR_IMAGE_LISTINGS.flatMap((listing) =>
      ["01", "02"].map((sequence) =>
        decodeAndValidateImage(
          path.join(assetRoot, "listings", listing.listingId, `${sequence}.webp`),
          { width: 1440, height: 1080 },
          `listing output ${listing.listingId}/${sequence} (${listing.modelId})`,
        )),
    ),
  ]);
}

async function validateSeedListingMapping() {
  const seedPath = path.join(projectRoot, "server", "used-car-db.ts");
  const seedSource = await fs.readFile(seedPath, "utf8");
  const listingBlockStart = seedSource.indexOf("const DEMO_LISTINGS");
  const listingBlockEnd = seedSource.indexOf("function assertDemoDataInvariants");
  assert.ok(listingBlockStart >= 0 && listingBlockEnd > listingBlockStart, "cannot locate DEMO_LISTINGS seed block");

  const seedModelIds = [
    ...seedSource
      .slice(listingBlockStart, listingBlockEnd)
      .matchAll(/modelId:\s*(?:"(model-[^"]+)"|USED_CAR_MODEL_IDS\.liL7)/g),
  ].map((match) => match[1] ?? "model-li-l7");
  assert.equal(seedModelIds.length, 30, `DEMO_LISTINGS must contain 30 model mappings; found ${seedModelIds.length}`);

  for (const [index, listing] of USED_CAR_IMAGE_LISTINGS.entries()) {
    assert.equal(
      listing.modelId,
      seedModelIds[index],
      `${listing.listingId} source model must equal its seeded modelId`,
    );
  }
}

validateUsedCarImageManifest();
const sourceRecords = await readSourceRecords();
const entriesByModelId = validateSourceCoverage(sourceRecords.entries);
const listingRecordsByFrame = validateListingSourceRecords(sourceRecords.listingSpecific);
await validateSeedListingMapping();
await validateOutputSets();
await validateOutputsMatchDeclaredSources(entriesByModelId, listingRecordsByFrame);

console.log(
  "Used-car real-photo QA passed: 46 sourced model images, 46 decoded model outputs, "
    + `30 exact listing/model mappings, ${listingRecordsByFrame.size} traced listing-specific sources, `
    + "and 60 decoded listing outputs.",
);
