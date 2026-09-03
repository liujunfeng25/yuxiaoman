# Exact-model source images

This directory contains the permanent, locally hosted derivatives for all 46
catalog models and the four Li Auto L7 inventory examples. The optimized files
in `../models/` and `../listings/` are built only from these model-identified
sources. Do not assign a photo by array position, body style, color, or visual
similarity.

## Required catalog sources

There is one licensed, traceable photo for every model in
`scripts/used-car-image-manifest.mjs`, stored using this layout:

```text
models/model-li-l7/cover.webp
```

The builder also accepts JPEG and PNG, but committed sources are normalized
WebP derivatives of at least 600 x 400 pixels. Original source URL, author,
license, photographed model, exact-model evidence, and localized derivative are
kept in the two `references/used-car-real-photo-sources-*.json` manifests. A
merely similar-looking vehicle is not an acceptable match.

## Optional listing-specific sources

If a seeded listing needs its own color, year, trim, or second angle, use:

```text
listings/used-car-listing-001/01.webp
listings/used-car-listing-001/02.webp
```

Without an override, that listing inherits only the source assigned to its exact
`modelId`. It never falls back to another model. A missing second angle repeats
the exact-model cover rather than substituting a visually similar car.

Validate without changing output files:

```text
node scripts/build-used-car-assets.mjs --check
```

For a future licensed source replacement, pass one or more directories or JSON
source manifests whose entries contain the exact seed `modelId` and a
project-relative `localFile`:

```text
node scripts/build-used-car-assets.mjs --check --source-manifest references/used-car-real-photo-sources-china.json --source-manifest references/used-car-real-photo-sources-global.json
```

The script rejects guessed ids, unknown ids, duplicate declared sources, missing
declared files, and any source set that does not cover all 46 models.

Build only after all 46 exact-model sources pass validation, then run the
byte-level provenance check:

```text
node scripts/build-used-car-assets.mjs
npm run check:used-car-assets
```
