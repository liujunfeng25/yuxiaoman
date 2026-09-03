# Used-car model photo assets

The used-car catalog now uses locally hosted photographs of the exact vehicle
model named by each `modelId`. The 46 model sources are mapped explicitly in
`scripts/used-car-image-manifest.mjs`; images are never assigned by array
position, body style, visual similarity, or modulo reuse.

## What the photos represent

- `models/*.webp`: 46 catalog covers, one for every seeded model.
- `listings/used-car-listing-001..030/{01,02}.webp`: the 60 images returned by
  the listing and detail APIs.
- The four Li Auto L7 demo listings have separate silver, black, dark-green,
  and white two-angle reference sets.
- Listings without a dedicated photo inherit only their own exact model photo.
  They never fall back to another model.

These are real-model reference photographs, not photographs of the synthetic
inventory record, VIN, inspection, or transaction shown in the demo. Prices,
mileage, registration dates, condition, defects, and inventory status remain
synthetic demonstration data.

## Sources and licenses

Every photo was selected from a Wikimedia Commons file page that identifies the
model and states a reusable license. Per-file source page, author, license, exact
model evidence, and localized derivative path are recorded in:

- `references/used-car-real-photo-sources-global.json` (20 models)
- `references/used-car-real-photo-sources-china.json` (26 models and eight
  Li Auto L7 listing-specific images)

The permanent source derivatives live under `real-sources/`. They are
auto-oriented, stripped of EXIF metadata, resized without enlargement to a
maximum edge of 2048 px, and encoded as WebP. Each derivative remains subject
to its source file's license; CC BY-SA derivatives are distributed under the
same compatible license with attribution retained in the manifests.

## Rebuild and verification

From the project root:

```text
node scripts/build-used-car-assets.mjs --check
node scripts/build-used-car-assets.mjs
npm run check:used-car-assets
```

The final check decodes all 106 public WebP outputs and recreates every
deterministic Sharp transform from its declared exact-model source. It fails if
a source is missing, mapped to another `modelId`, too small, or if a stale/wrong
output remains in place.

The seeded API URLs include the `real-model-v1` asset version so an existing
browser session does not keep displaying an older, cache-fresh demo image. Bump
`USED_CAR_ASSET_VERSION` in `server/used-car-db.ts` whenever these public pixels
are replaced again.

## Owner vehicle identity illustrations

`owner-models/*.webp` is the server-hosted 12-model presentation library. The
native WeChat mini-program carries its own `720 x 405` transparent PNG copies
under `miniprogram/assets/vehicles/` so real-device rendering does not depend
on a LAN HTTP image request or transparent-WebP decoding. Six catalog logos
are packaged locally as PNG as well. These three-quarter-view illustrations
were generated as synthetic demonstration assets on 2026-08-20. They are not
official manufacturer photography and do not promise a specific model year,
trim, plate, or configuration.

The lossless generation sources are retained under
`source-assets/owner-vehicles/`. Rebuild the transparent WebP derivatives and
the split Tianjin hero background with:

```text
node scripts/build-owner-vehicle-assets.mjs
node scripts/check-owner-vehicle-assets.mjs
```

The API exposes the visible `车型示意图` disclosure together with this catalog.
These assets are used only for identity and UI display; inspection facts and
rules continue to come from the user-confirmed vehicle profile fields.
