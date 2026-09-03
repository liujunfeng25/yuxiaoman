# Visual QA references

These files are the fixed visual sources of truth for the interview MVP. They are references only; UI text, controls, status, icons, and data must be rendered as accessible React components rather than baked into screenshots.

| File | Screen | SHA-256 |
| --- | --- | --- |
| `selected-owner-home-v2.png` | Consumer home, annual-inspection stages, and three-tab shell | `260CB5098FB0BB3812AE610FE3B8409993D625D1472A58FFD1F21AEE70E59011` |
| `operator-workbench-visual-reference.png` | Operator workbench / task list | `C8A6C8E7909C6B932CDED191A6A8B72EEEE5D9C3262D9D6E43F01EDC415CF82A` |
| `operator-booking-detail-visual-reference.png` | Operator single-booking fulfillment detail | `FE0AB899C5DB5932285925A15FEC8FB47B42B57BD4B86F10A5FACF915F8FFBC4` |
| `insurance-lead-selected.png` | Consumer car-insurance renewal lead intake | `7CABA3E5E79544C5368B8F31B36552498EC0A670EE6492FED5CCC314B8C4A3D5` |
| `car-rental-search-selected.png` | Consumer car-rental search-first landing and transparent pricing direction | `8335215A7A5045254686D2474EBE7433AB7703FDE16024AE2610F01BE6FAEA2A` |
| `used-car-showroom-selected.png` | Used-car double-column inventory showroom | `3D2FA0D21F1BE709815C70BA08A62E872CBC56673C88F0EDC4484A33233633DF` |
| `used-car-brand-picker-selected.png` | Used-car brand search, logos, groups, counts and initial index | `7AA6C23A6703578B63205E5D939E398D5433A13943BF5B2E53EE805BF51D43E7` |

For visual QA, render the matching state at a 390 × 844 app viewport and compare side by side. The car-rental search reference is the active source of truth for the rental module. The two older 852 × 1868 used-car references remain historical records and must be density-normalized if used to verify shared brand/model components. Check information hierarchy, spacing, type scale, card anatomy, status emphasis, bottom safe area, clipping, and horizontal overflow. The operator references inherit the product's cool blue/white tokens even when a source screenshot contains different colors.

People, plates, inspection stations, rental stores, fleet records, prices, deposits, policies, orders, and results shown by the implemented product are synthetic demo content. The shared vehicle-catalog imagery is licensed, traceable photography of the corresponding real vehicle model, but it does not depict the physical vehicle assigned to an order or a specific VIN.

## Vehicle-model photo provenance

- `used-car-real-photo-sources-global.json`: 20 global/joint-venture models.
- `used-car-real-photo-sources-china.json`: 26 Chinese-brand models plus eight
  listing-specific Li Auto L7 reference images.

Each record keeps the exact `modelId`, Commons file page, author, license,
exact-model evidence, original download URL, and permanent localized derivative.
The build and QA scripts reject missing models and cross-model fallbacks.
