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
`version`, `id`, `boundary`, `base`, `reference`. Its sidecar SHA256 must match the exact original
UTF-8 bytes, including line endings. UTF-8 decoding preserves a BOM so the ASCII parser rejects it.

- AAIGrid `.asc`: square, corner-origin cells (`xllcorner`, `yllcorner`, `cellsize`), north-first
  rows, finite decimal heights and optional finite `NODATA_value`. Each cell is an explicitly
  piecewise-constant area elevation. Missing cells remain missing. Center-origin point-sample,
  DX/DY, rotated or ambiguous products are rejected.
- ASCII PLY 1.0: x/y/z float or double vertices and indexed triangular faces. It must describe a
  single-valued 2.5D top surface. Point-only, binary, extra semantic properties, closed solids,
  vertical faces, projected overlaps and inconsistent shared heights are rejected. No automatic
  point meshing, gap bridging or convex-hull filling is performed.
- Typed JSON retains either numerical representation directly. Imports are bounded at 8 MiB for
  ASC/PLY; library JSON parsing allows 16 MiB, while the current CLI regular-file reader allows
  8 MiB. Caps include 32,768 vertices/cells, 16,384 triangles, 64 boundary vertices, eight holes,
  and separate candidate/intersection/contribution budgets. Over-budget work fails explicitly.

Numeric ASC/PLY exports include a matching regenerated sidecar. The original source hash remains
in the retained request and manifest. LAS/LAZ, GeoTIFF, raw-point meshing, classification and
photogrammetric reconstruction require separately qualified adapters. File extensions do not
establish CRS, vertical datum, ground classification or accuracy.

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
basal surfaces, acquisition calibration and full field acceptance. See [ADR 19](adr/0019-known-surface-volumes.md).

Format and policy references: [GDAL AAIGrid](https://gdal.org/en/stable/drivers/raster/aaigrid.html),
[indexed PLY](https://www.loc.gov/preservation/digital/formats/fdd/fdd000501.shtml),
[TIN polygon volume](https://pro.arcgis.com/en/pro-app/3.5/tool-reference/3d-analyst/polygon-volume.htm),
and [USGS independent accuracy evidence](https://www.usgs.gov/ngp-standards-and-specifications/lidar-base-specification-data-processing-and-handling-requirements).
