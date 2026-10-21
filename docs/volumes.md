# Known-surface stockpile volumes

The owned volume engine processes an existing georeferenced surface. Acquisition, reconstruction
and volume measurement are separate stages. Survey PNG imagery is not a numerical elevation
surface. This engine neither reconstructs it nor invents terrain from unordered points.

```sh
./buddy volumes:demo --scenario pyramid --output /tmp/new-pyramid-volume
./buddy volumes:process examples/stockpile/request.json
./buddy volumes:import examples/stockpile/surface.asc --format asc --metadata examples/stockpile/metadata.json --measurement examples/stockpile/measurement.json --output /tmp/new-grid-volume
```

The example grid is explicitly synthetic: four 1 m² cells with elevations 1, 2, 3 and 4 m above
a zero base produce 10 m³. `/volumes` runs analytic scenarios and displays the actual known
surface, boundary, coverage, base, reference evidence and paginated contribution audit. Native
Stacks `defineCommand` commands also compile into the standalone drone CLI.
The `grid-nodata` scenario exposes 19 measured cell areas and one missing cell, with multiple audit
pages. Its 86 m³ covered-domain sum does not establish the full-boundary volume.

## Reference and provenance contract

`VolumeRequest` v1 contains the surface, an operator boundary, a plane base and an optional
independent volume reference. Coordinates are **easting, northing, elevation up in metres**,
distinct from vehicle LOCAL_NED. Supported horizontal references are an explicit engineering
`LOCAL:` definition or WGS84 UTM EPSG:32601..32660 / EPSG:32701..32760. The vertical datum,
coordinate epoch, axes and units are mandatory declarations. There is no reprojection, geoid
correction or implicit conversion from degrees, feet or vehicle NED.

Metadata retains the source SHA256, acquisition and reconstruction identities, boresight/time
calibration reports, classification assumptions, and declared horizontal/vertical error bounds.
Unknown fields remain unknown. An operator declaration does not authenticate a survey or certify
a calibration. A LiDAR stockpile top must not be silently replaced by only class-2 ground points.

The boundary is a simple concave or convex polygon with optional disjoint holes. It is a measurement
boundary, not a flight fence or automatically detected stockpile toe. The base is an explicitly
anchored affine plane with east/north gradients, a disclosed assumption and nullable vertical error
bound. A pre-stockpile surveyed base differs from an operator-assumed basal plane. Independent
base TIN overlays and inferred toe/base fitting remain future work and are rejected as base kinds.

## Actual numeric interchange

`volumes:import` requires a source file, its metadata JSON and a measurement JSON containing exactly
`version`, `id`, `boundary`, `base`, `reference`. For ASC/PLY, the metadata SHA256 must match the exact
original UTF-8 bytes, including line endings. UTF-8 decoding preserves a BOM so the ASCII parser
rejects it. GeoTIFF uses the separate wrapped declaration below and hashes the original binary bytes.

- AAIGrid `.asc`: square, corner-origin cells (`xllcorner`, `yllcorner`, `cellsize`), north-first
  rows, finite decimal heights and optional finite `NODATA_value`. Each cell is an explicitly
  piecewise-constant area elevation. Missing cells remain missing. Center-origin point-sample,
  DX/DY, rotated or ambiguous products are rejected.
- ASCII PLY 1.0: x/y/z float or double vertices and indexed triangular faces. It must describe a
  single-valued 2.5D top surface. Point-only, binary, extra semantic properties, closed solids,
  vertical faces, projected overlaps and inconsistent shared heights are rejected. No automatic
  point meshing, gap bridging or convex-hull filling is performed.
- Numeric GeoTIFF: the restrictive `classic-le-f32-utm-area-v1` profile below produces the same
  constant-cell geometry, with the original binary digest retained. This is explicit
  `--format geotiff`; neither file extension nor TIFF magic chooses a format automatically.
- Typed JSON retains either numerical representation directly. Imports are bounded at 8 MiB for
  ASC/PLY; library JSON parsing allows 16 MiB, while the current CLI regular-file reader allows
  8 MiB. Caps include 32,768 vertices/cells, 16,384 triangles, 64 boundary vertices, eight holes,
  and separate candidate/intersection/contribution budgets. Over-budget work fails explicitly.

Numeric ASC/PLY exports include a matching regenerated sidecar. The original source hash remains
in the retained request and manifest. LAS/LAZ, broader GeoTIFF profiles, raw-point meshing,
classification and photogrammetric reconstruction require separately qualified adapters. File extensions do not
establish CRS, vertical datum, ground classification or accuracy.

## Declared GeoTIFF cell elevations

```sh
./buddy volumes:import /path/surface.tif --format geotiff --metadata /path/elevation-declaration.json --measurement /path/measurement.json --output /tmp/new-geotiff-volume
```

For this format, `--metadata` is a JSON elevation declaration with exactly these fields:

| Field | Required value |
|---|---|
| `version` | `1` |
| `profile` | `"classic-le-f32-utm-area-v1"` |
| `sampleMeaning` | `"cell-elevation-metres-up"` |
| `interpretation` | `"piecewise-constant-cell-elevation"` |
| `metadata` | The complete existing `SurfaceMetadata` reference and provenance contract |

The nested metadata retains every explicit field and nullable unknown, including the exact original
TIFF SHA256 in `provenance.sourceSha256`. Every declaration object has closed keys. The entire
original JSON string is limited to 32,768 code units and UTF-8 bytes before parsing. Ordinary JSON
whitespace and key order are accepted; duplicate keys follow native JSON parsing, so only their
final values are validated. A BOM is preserved and rejected. The binary file is never UTF-8 decoded.

The pure library entrypoint is
`importGeoTiffSurface(bytes: Uint8Array, declarationJson: string): Promise<GeoTiffCellSurface>`.
It snapshots the exact visible bytes synchronously before its first await. Buffer and genuine
Uint8Array subviews are accepted without reading caller properties or iteration hooks. Shared,
resizable, detached and proxy-backed views are rejected. The result owns its metadata and
north-first rows. The Node-only `readGeoTiffFile` stays outside the pure drone barrel.

The profile accepts one classic little-endian TIFF IFD and one full-height, uncompressed,
32-bit IEEE floating-point strip, at most 8 MiB and 32,768 cells. Width, height, strip offsets and
byte counts have explicit LONG types; sample/orientation/planar/predictor fields must be explicit
and match the profile. Positive `XResolution` and `YResolution` rationals and `ResolutionUnit`
1, 2 or 3 are required TIFF bookkeeping; they do not scale the declared terrain coordinates.
Unknown, duplicate or unsorted tags, overlapping regions and nonzero padding are rejected.
Even-aligned external payloads may appear in different orders; arbitrary trailers are rejected.
BigTIFF, big-endian, compression, tiles, multiple strips/IFDs, integer/Float64 samples and imagery
color products are outside this profile.

GeoKeys must explicitly declare projected WGS84 UTM EPSG:32601..32660 or EPSG:32701..32760 and
RasterPixelIsArea, matching the sidecar CRS; an optional projected-unit key must mean metres.
ModelPixelScale is `(S,S,0)` and the sole tiepoint is `(0,0,0,W,N,0)`. Cells have west corner `W`,
south corner `N - height*S` and north-first rows, without a half-cell shift. The sidecar supplies
the vertical datum and metre-up sample meaning. There is no vertical transformation, CRS
conversion, rotation, point-sample reinterpretation or acquisition verification.

Optional GDAL_NODATA is a finite ASCII decimal that must represent an exact Float32 value.
For example `0.1` is rejected because it rounds, while `0.100000001490116119384765625` is exact.
Either zero sentinel matches both zero signs. Without that tag every finite cell is measured;
there is no implicit missing value. NaN, infinity and all-missing surfaces are rejected. Missing
cells remain null through the unchanged covered-area integration.

The importer reports only `geotiff-surface-input` (TypeError), `geotiff-surface-budget`
(RangeError), `geotiff-source-sha256-mismatch` or `geotiff-surface-unavailable`.
The binary file reader reports `geotiff-file-unavailable` for path, flag, open, regular-file,
size, read or close failure. It requires nonblocking/no-follow flags, rejects a final symlink
and special file, reads at most 8 MiB plus one growth-detection byte, and closes the descriptor.
Parent directories remain followed and caller-authorized. Concurrent file writes are not an
atomic snapshot guarantee.

The existing dataset writer retains the original TIFF digest in `request.json` and the manifest.
It regenerates `surface.asc` with a separately hashed matching sidecar. This does not archive the
TIFF, export TIFF or reconstruct its original bytes. Reprocessing the retained request uses the
same numerical geometry and report. The independent small synthetic fixture checks missing-area
volumes against a hand calculation and an ASC surface; it does not establish external GDAL/libtiff
interoperability, field accuracy or survey acquisition. Issue #19 remains open.

## Auditable integration and coverage

Define `d = surface elevation - base elevation`. The engine clips every source primitive against
the exact boundary, triangulating concave rings and subtracting holes. It splits each clipped
piece at `d=0` before integrating affine elevation over horizontal area. TIN elevation is affine
per face; grid height is constant per cell. An affine triangle integrates as area times the mean
of its three height differences. Anchor-relative geometry and compensated sums limit cancellation
at large projected coordinates.

- `aboveBaseM3 = integral(max(d, 0))`, potential material removal to reach the base.
- `belowBaseM3 = integral(max(-d, 0))`, potential fill to reach the base.
- `signedTopMinusBaseM3 = aboveBaseM3 - belowBaseM3`.

These are covered-domain values. Missing grid cells and TIN gaps are not zero height, interpolated
or scaled by coverage percentage. `fullBoundarySignedM3` remains null when uncovered area exceeds
`max(1e-8 m², boundaryArea * 1e-10)`. The report retains coverage and each clipped polygon, source ID,
area, cut/fill and boundary weight. Piece values are unweighted: sum `weight * value`; holes have
weight -1. This preserves an independently auditable calculation.

## Uncertainty and comparison

When both pointwise vertical bounds are declared, a conditional worst-case volume bound is
`coveredArea * (topBound + baseBound)`. Unknown top/base bounds produce null. This bound does not
include horizontal misregistration, uncertain boundaries, classification mistakes, unobserved
basal geometry, missing coverage or calibration errors. `overallAccuracyBoundM3` is always null.
Dense samples do not justify reducing systematic errors by the square root of the sample count.

An optional independent reference requires a separate identity/hash, survey date, method,
independence declaration and identical CRS/datum/epoch, boundary and base convention. The report
compares above/below/signed values and signed relative error (null at zero reference). The
`withinCombinedDeclaredBound` flag checks the **signed** difference only; matching net cut/fill can
hide opposing above/below differences, which are reported separately. Partial coverage prevents
full-boundary comparison. Synthetic references stay synthetic and operator references remain
operator declarations. Neither establishes physical accuracy.

## Dataset completion and evidence

`writeVolumeDataset` validates and recomputes the request, then exports `request.json`, `report.json`,
`contributions.csv`, numeric `surface.asc` or `surface.ply`, `surface.metadata.json` and `manifest.json`.
The manifest records per-file hashes/lengths, the integration policy and evidence limits. Outputs
use a new private directory and exclusive 0600 files. The shared completed-artifact writer snapshots
bytes before IO, syncs files/directories and publishes the completion manifest last. A partial
directory without `manifest.json` is incomplete. Hashes establish consistency, not authenticity.
The local protocol requires hard links and directory fsync in operator-controlled parents; it is
not a measured storage hardware power-loss guarantee.

Analytic tests independently establish a 16 m³ pyramid, clipped affine wedges, simultaneous
0.5 m³ cut and 0.5 m³ fill, holes, nodata, large coordinate translations, conditional error
growth and incompatible reference rejection. Native CLI tests exercise import, private export,
reprocessing and PLY reimport. These establish processing behavior, not field accuracy or an
executed GDAL/PDAL interoperability campaign. No physical reference survey has been performed.

Issue [#19](https://github.com/stacksjs/drone/issues/19) remains open for measured independent survey
comparison, larger external datasets, numeric raster/point-cloud adapters, qualified meshing and
basal surfaces, acquisition calibration and full field acceptance. See [ADR 19](https://github.com/stacksjs/drone/blob/main/docs/adr/0019-known-surface-volumes.md).

Format and policy references: [GDAL AAIGrid](https://gdal.org/en/stable/drivers/raster/aaigrid.html),
[indexed PLY](https://www.loc.gov/preservation/digital/formats/fdd/fdd000501.shtml),
[TIN polygon volume](https://pro.arcgis.com/en/pro-app/3.5/tool-reference/3d-analyst/polygon-volume.htm),
and [USGS independent accuracy evidence](https://www.usgs.gov/ngp-standards-and-specifications/lidar-base-specification-data-processing-and-handling-requirements).
