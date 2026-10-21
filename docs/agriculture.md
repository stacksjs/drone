# Owned agriculture sensing

Issue [#21](https://github.com/stacksjs/drone/issues/21) adds raw red/NIR crop scouting, a calibrated
field sampling layer, parcel summaries and explicit operator-selected livestock observations.
The owned survey sensor, estimator, mission, authority, controller and modeled board run the route.
ArduPilot and PX4 are optional drivers and are not required here. Physical outputs remain inhibited.

```sh
./buddy agriculture:plan examples/agriculture.json
./buddy agriculture:simulate --output /tmp/new-field-visit
./buddy agriculture:process /tmp/new-field-visit/recording.json
```

The standalone compiled CLI exposes the same commands outside the checkout. Open `/agriculture`
for raw pixel provenance, visible/index capture views, sample inspection, parcel reports and explicit
livestock declarations. Default collection completes with 32 acknowledged multi-band frames. An
incomplete run cannot count as a successful demonstration of a later injected hazard.

## Calibration and raw measurements

Visible RGBA is a separate image. Red and NIR are unsigned 16-bit numeric bands on an explicitly
registered optical grid, with wavelength, bandwidth, calibration, capture/exposure/gain and
irradiance records. They are never inferred from visible colours. The default lens, common optical
grid, panels, irradiance, scene and sensor response are synthetic, not a physical Pi calibration.

The `micasense-v1` numerical model follows the published
[MicaSense radiometric model](https://support.micasense.com/hc/en-us/articles/115000351194-Radiometric-Calibration-Model-for-MicaSense-Sensors).
It normalizes DN and black level by 65536, applies radial vignette and row response, then exposure,
gain and radiometric coefficients to obtain spectral radiance in W/m²/sr/nm. A raw coordinate
belongs to its calibration grid; silently moving or rescaling a crop invalidates that relationship.
`agricultureRadiance` also permits scalar verification on the original larger sensor grid. The
bounded frame processor supports at most 65,536 pixels and does not implement TIFF/XMP ingestion
or a measured crop/registration adapter.

Each band retains unsaturated raw panel pixel samples, exposure/gain, certificate label, reference
reflectance/uncertainty, irradiance and epoch. The most recent earlier panel must be within its age
budget. As described by the
[MicaSense panel workflow](https://support.micasense.com/hc/en-us/articles/115000765514-Use-of-Calibrated-Reflectance-Panels-For-MicaSense-Data),
mean corrected panel radiance provides a per-band reflectance factor. Here scene radiance is
multiplied by panel reflectance/panel radiance and by panel irradiance/scene irradiance. Stale or
future irradiance, missing panels, wrong band identities, incompatible grids, bad denominators and
excessive registration or synchronization error reject the frame. A certificate ID is a declaration,
not verification that a panel has been measured.

Individual saturated, below-black or impossible-reflectance pixels remain masked. A near-zero
index denominator produces nodata. The processor never turns those cases into an apparently good
zero index. Admission requires at least half the pixels to remain valid. Mask counts and invalid
reasons are retained.

## Index verification and uncertainty

The index is `(NIR - red) / (NIR + red)` using calibrated reflectance, consistent with the
[USGS NDVI definition](https://www.usgs.gov/landsat-missions/landsat-normalized-difference-vegetation-index).
A fixed -1..1 display scale is used; grey is nodata. Colours are not crop-health classifications.
Conditional interval bounds include declared radiance, irradiance and panel-reflectance uncertainty
and DN quantization. They do not establish sensor accuracy, registration accuracy or agronomic
confidence. More uncertain pose and mixed vegetation/soil/materials remain separate limitations.

An independently evaluated extract from pinned official MicaSense red/NIR panel images verifies
per-pixel radiance, per-band reference-panel correction and the ratio of the resulting ROI means.
The fixture retains raw DN, original coordinates/metadata, upstream image/source SHA-256 hashes,
MIT notice, expected results and method. See
[the reference fixture](https://github.com/stacksjs/drone/blob/main/tests/fixtures/agriculture/README.md). Those different ROIs observe
reference-panel material; they are not registered crop pixels and cannot prove a vegetation map.
Separately worked synthetic landmarks and actual owned-runtime images test map projection and
illumination correction. These distinct checks do not prove physical field accuracy.

NDVI alone does not identify disease, water stress, yield, species, feed requirements or an
application prescription. No autonomous spraying or animal identity inference is performed.
Agronomic interpretation needs appropriate ground measurements, crop/season context and qualified
field validation.

## Route, timing and field support

`createAgriculturePlan` reuses the polygon/hole-aware survey planner, explicit LOCAL_NED origin,
calibrated nadir lens, flat/sloped terrain plane, endurance and owned quad mission limits.
Parcel rectangles have nonoverlapping interiors and are clipped to the surveyed field and holes.
The v1 parcel representation is rectangular; arbitrary parcel polygons remain future work.

A shared generic modeled shutter delivers the complete raw-band and visible frame in one scoped
ACK. Existing visible/thermal camera interfaces retain their original shape. Agriculture admission
checks session, sequence, reference, issue/capture/ACK epochs and raw-band synchronization before a
visible survey capture becomes available. An uncertain outcome is never retried. Camera truth is
used only to form sensor pixels; metadata and processing use the estimator's qualified capture pose.
Opaque modeled animals select the same material in all optical bands and the separate visible view.
They do not create operator observations automatically.

`processAgriculture` caches calibrated source images, projects grid centres through estimated
capture pose and calibrated optics, and chooses a qualified nearest-view source pixel. It retains
uncovered, masked and zero-area cells instead of filling them with invented observations. Field,
hole, cell and parcel support areas use exact polygon clipping. Grid edges are truncated to the
field bounding box. The reported areas weight grid-centre samples; they do not assert that every
point within a cell was measured. The result is a sampling layer, not image reconstruction or a
seam-corrected orthomosaic. RTK, PPK and surveyed ground control remain unavailable.

Transient irradiance loss, band skew, saturation, lost/wrong shutter ACK, position loss, RC override
and operator abort are exercised. Good data returning cannot re-engage a latched failure. Every
terminal fixture revokes modeled outputs. Abort at height releases modeled thrust and is not a
controlled emergency landing.

## Explicit livestock observations

`createLivestockObservation` requires an animal label, source capture, integer pixel, observer,
canonical UTC timestamp and note. It projects that pixel centre using estimated pose, requires a
field/parcel association, and binds original visible/raw bytes, calibration and capture metadata
with SHA-256. Identity and physical animal presence remain unverified. The label is an explicit
operator declaration, not an automatic detection, identification or continuity claim. Changing the
workspace capture clears an unsubmitted selection; retained records remain tied to their original
capture. No target switching or automatic reacquisition is introduced.

```sh
./buddy agriculture:observe /tmp/new-field-visit/recording.json \
  --id observation-one --animal selected-animal --capture photo-0016 \
  --x 48 --y 36 --observer operator-one --observed-at 2026-10-18T12:00:00.000Z \
  --note 'Explicit selected-animal declaration; identity unverified' \
  --output /tmp/new-field-observation
```

The pixel must actually project inside the field and parcel. Use the source imagery and retained
geometry to make that explicit selection. `--observations` validates and retains an existing array
when adding another declaration. `agriculture:process --observations <path>` also validates and retains
those declarations when reprocessing a recording; output is always a new private dataset. Workspace observations
remain in the analysis session; the CLI retains them on disk.

## Evidence, export and remaining acceptance

Recordings are bounded unsigned simulation artifacts: 64 captures, 65,536 pixels each, 64 MiB raw,
16 MiB recording JSON and 64 observation declarations. Validation recomputes planning, mission
decisions, visible/raw ACK and pose joins, calibrated numeric admission and explicit source bindings.
It does not replay omitted raw sensors or authenticate a camera, observer, animal or physical event.

Private exports include original visible PNGs, per-band little-endian uint16 DN and metadata,
recording, numeric layer, GeoJSON cell-centre points, parcel report and declarations. The shared
artifact writer snapshots and syncs exclusive private files/directories before publishing the
content-hash completion manifest. Partial directories without that marker are incomplete.
Hashes are unsigned and storage hardware power-loss durability has not been measured.

Keep #21 open for measured multispectral hardware/panels/irradiance, synchronization and registration,
real field/dataset interchange, physical range/heading/pose accuracy, external known crop-map
comparisons, ground agronomic measurements, real explicitly reviewed livestock records, richer
parcel models, bench/HIL/vehicle campaigns and any physical operator/privacy requirements. The owned
software evidence does not complete those acceptance gates. See [ADR 21](adr/0021-agriculture-sensing.md).
