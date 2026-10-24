# LAS point-grid stockpile processing

`importLasSurface(bytes, declarationJson)` converts explicitly selected georeferenced
LAS points into a declared cell-mean surface. The existing [volume engine](volumes.md)
then integrates that representation against an operator boundary and plane base. This
separates point acquisition, representation construction and volume computation.

```sh
./buddy volumes:import /path/points.las --format las --metadata /path/las-declaration.json --measurement /path/measurement.json --output /tmp/new-las-volume
```

The same command compiles into the standalone CLI. It never acquires LiDAR, commands
a vehicle, classifies a stockpile or verifies physical survey accuracy. LAS handler failures
use bounded format-specific diagnostics without echoing private filenames or input bodies.

LAS errors retain the fixed library codes `las-surface-input`, `las-surface-budget`,
`las-surface-unavailable`, `las-surface-no-supported-cells`,
`las-source-sha256-mismatch`, `las-file-unavailable`, `las-dataset-source-input` and
`las-dataset-source-mismatch`. Other handler failures, including declaration,
measurement and output filesystem failures, emit `las-import-unavailable` with
exit 1. Output writes are awaited; an error-pipe failure keeps exit 1. Partial
output or partial dataset roots can remain after a delivery failure. Accept a
successful result only after complete streams and exit 0.

## Explicit declaration

The UTF-8 JSON declaration is limited to 32,768 bytes and code units. Closed objects
require the following fields. JSON duplicate keys follow native parsing, so the final
value is validated; a BOM is rejected.

| Field | Meaning |
|---|---|
| `version` | `1` |
| `profile` | `"las12-utm-mean-grid-v1"` |
| `verticalReference` | `"declared-sidecar"`, with no vertical transformation |
| `metadata` | Complete existing `SurfaceMetadata`, including exact original LAS SHA256 |
| `selection.classes` | Nonempty sorted unique class numbers, 0 through 31; no default ground filter |
| `selection.returns` | `"all"`, `"first"` or `"last"` |
| `selection.synthetic` | `"exclude"` or `"include"`; withheld points are always excluded |
| `grid.westM`, `grid.southM` | Declared southwest grid corner in metres |
| `grid.width`, `grid.height` | Positive integer dimensions, at most 32,768 cells total |
| `grid.cellSizeM` | Square cell size from 0.00001 through 1,000,000 metres |
| `grid.minimumPoints` | Minimum selected samples per cell, 1 through 200,000 |
| `grid.maximumSpreadM` | Maximum selected elevation range per cell, 0 through 100,000,000 metres |

The metadata requires WGS84 UTM and either synthetic analytic or operator-imported
LiDAR provenance. The header projection must match its EPSG code and metre units.
The vertical datum is an explicit sidecar declaration. An embedded vertical CRS must
both match that declaration and belong to the verified metre-up profile below. A matching
label or explicit metre-unit key cannot override a CRS's actual units or axis direction.
No coordinate or geoid transformation is performed; datum accuracy remains unverified.
Unknown classification, calibration and georeferencing status remain unknown.

Points are assigned by `floor((east-west)/size)` and `floor((north-south)/size)`.
Cells include their west/south boundaries and exclude east/north boundaries. Internal
edges belong to the east/north cell. Output rows run north to south. No epsilon snap
changes a point's cell. The importer uses compensated elevation sums and reports
counts, minima, maxima and means. Cells below the count threshold or above the spread
threshold remain null. A file with no supported cell is refused rather than reported
as a zero-volume stockpile.

Selection exclusions are disjoint in this order: withheld, synthetic, class, return,
outside grid. The audit also retains the complete source class/return histograms.
Class numbers are source labels, not verified material identities. Last returns do
not automatically establish bare earth, and class 2 alone must not silently substitute
the underlying ground for a stockpile top.

## Representation and uncertainty

Each accepted sample mean represents its entire cell by an explicit modeling assumption.
The volume engine's covered area refers to these modeled cells, not independently
verified laser footprints or ground coverage. Duplicate points carry duplicate sample
weight. Count and within-cell spread do not bound unsampled terrain, systematic bias,
occlusion or representation error. `pointSamplingCoverageVerified` and
`physicalAccuracyVerified` remain false; `representationErrorBoundM` remains null.
No uncertainty is inferred from sample count or spread.

Missing cells are not filled, and covered-domain volumes are not scaled to a full
boundary total. Conditional declared vertical bounds retain the volume engine's
assumptions; they do not become an overall physical accuracy bound. The volume report
keeps acquisition/reconstruction flags false for the integration stage. The separate
processing audit records `griddingPerformed: true` and its declared cell model.

## Supported binary profile

This profile follows the header, point layouts and classification flags in the
[ASPRS LAS 1.2 specification](https://liblas.org/_static/files/specifications/asprs_las_format_v12.pdf),
particularly its public-header, GeoKey-directory and point-record tables. It accepts
the 227-byte little-endian 1.2 header and uncompressed point formats 0, 1, 2 and 3 with
their exact standard record lengths. Scale/offset coordinates, source bounds and
per-return counts are checked against every point, including excluded points.
Bounding-box comparison permits only eight binary64 epsilon-scaled rounding units;
this numerical check is not a survey tolerance. Returns must be from 1 through 5,
consistent with total returns; signed scan-angle ranks must lie within 90 degrees.

The sole VLR must be an inline `LASF_Projection` GeoKey directory. Required keys are
projected model, matching WGS84 UTM CRS and metre linear units. Optional point-raster,
WGS84 geographic CRS and degree angular units have explicit checks. The optional
vertical-unit key must declare metres. Embedded vertical CRS admission is limited to
EPSG:3855 (EGM2008), 5701 (ODN), 5703 (NAVD88), 5714 (MSL height), 5773 (EGM96) and
5783 (DHHN92). These map to the metre/up axis in the pinned
[PROJ vertical CRS records](https://github.com/OSGeo/PROJ/blob/5fa31c29f0a806568ed7bc76c1a557604db4a804/data/sql/vertical_crs.sql)
and [axis definitions](https://github.com/OSGeo/PROJ/blob/5fa31c29f0a806568ed7bc76c1a557604db4a804/data/sql/axis.sql).
Feet-based, depth-positive, unknown and other unqualified embedded CRSs are refused,
even if their IDs match the sidecar and a separate key claims metres. The processing
audit retains the actual embedded ID or its absence, declared datum, metre/up
interpretation and explicit false transformation/datum-verification flags. Unsupported keys, extra VLRs, referenced parameter tables, custom transforms,
compressed data, extended headers/records and arbitrary trailers are refused. Zero
padding before the point table is permitted. Source files are limited to 8 MiB and
200,000 points. Coordinates and grid edges must fit within 100,000,000 metres.

GPS fields in formats 1 and 3 retain week-seconds or adjusted standard GPS time with
an observed range. They are not UTC or validated sensor-clock alignment. RGB, intensity,
user data, source IDs and scan-direction/key-point flags do not determine the elevation
mean; original bytes remain available in exported datasets. Colors are not interpreted
as calibrated imagery. This is an explicit supported profile, not general LAS/LAZ support.

The pure importer synchronously captures native unshared, fixed Uint8Array/Buffer
visible bytes before its first await. It avoids caller accessors and iteration hooks;
proxy, shared, resizable and detached storage are refused. The Node-only `readLasFile`
uses the existing bounded regular-file reader and stays outside the pure drone barrel.

## Retained evidence and replay

With `--output`, the private completion-marked dataset contains the usual request,
report, contribution CSV, generated ASC grid and matching sidecar, plus:

- `source.las`: exact original point bytes;
- `source.declaration.json`: exact declaration used for selection and gridding;
- `source.gridding.json`: source/declaration hashes, format, time convention,
  exclusions, histograms, grid choices and per-cell statistics.

The writer recomputes gridding and refuses a source/declaration that does not reproduce
the requested surface before creating a dataset. The completion manifest hashes every
file and distinguishes original point bytes from the regenerated ASC hash. Replaying
`request.json`, reimporting the ASC, or importing the retained LAS/declaration preserves
the numerical report. The normal console summary omits the per-cell table; it remains
in the audit file and the pure importer result.

The literal eight-point worksheet in `tests/fixtures/volumes/las.ts` was independently
encoded from the format tables. Five selected points yield north-first means
`[[3,6],[9,null]]`: three modeled square metres and 18 cubic metres above an explicit
zero base, with the fourth cell unknown. It is synthetic evidence. Tests cover count,
spread, class/return/flag selection, formats 0-3, malformed headers/records/projection,
byte ownership, digest refusal, publication integrity and native replay. The copied
CLI qualifier retains actual outputs and dataset hashes outside the checkout.

Broader LAS/LAZ and VLR profiles, point triangulation, richer surfaces, streaming/tiled
processing, measured calibration/classification and independent surveyed comparisons
remain open under [#19](https://github.com/stacksjs/drone/issues/19). Physical survey
and storage power-loss qualification are separate from these software checks.
