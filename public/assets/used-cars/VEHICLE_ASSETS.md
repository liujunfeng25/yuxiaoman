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

## Owner vehicle catalog photos

The owner-facing picker is a separate presentation system from the used-car
photo catalog. It exposes all 1,581 reviewed series cutouts across 148 brands
and vehicle forms: 12 approved original cutouts under `owner-models/` and 1,569
additions under `owner-presentation-v2/`. Every card uses a white vehicle, front-left
three-quarter view, consistent scale, transparent 1120 x 630 canvas and a
restrained studio shadow. Road, showroom, rear-view and differently cropped
photos are not used by the owner picker.

The explicit model bindings live in `server/vehicle-catalog-images.ts` and the
generated-asset record, exact-model references and prompt specification live in
`references/owner-vehicle-presentation-v2.json`. Every catalog series has its
own reviewed image binding; the UI does not create an empty image card and no
model receives another model's image. Passenger vehicles, buses, tractors,
trucks and trailers are all covered. The approval state is tracked in
`references/owner-vehicle-presentation-inventory.json`: 1,581 approved and zero
awaiting source material.

The native mini-program keeps only six small catalog logos locally. Model
photos are served by the API, cached, and lazy-loaded only for the active brand;
they are not included in the mini-program main package.

Rebuild the v2 alpha assets and verify the full presentation set with:

```text
node scripts/build-owner-presentation-assets.mjs
npm run check:owner-vehicle-assets
```

The API labels visible assets `车型展示图`. They identify a catalog series and
support UI presentation; they do not represent the owner's year, trim, chosen
exterior color or physical vehicle. Inspection facts and rules continue to come
from the user-confirmed vehicle profile fields.
