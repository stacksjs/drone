# Owned asset inspection

Issue #20 implements a bounded bridge-face workflow on the owned raw sensor, estimator, mission,
authority, quad controller and independent modeled board loop. It plans an asset-relative route,
records visible and synthetic thermal pixels, binds explicit operator reviews to source evidence,
and compares repeat-visit capture geometry. Physical outputs remain inhibited.

```sh
./buddy inspection:plan examples/inspection.json
./buddy inspection:simulate --visit before --output /tmp/new-inspection-before
./buddy inspection:simulate --scenario wind --visit after --output /tmp/new-inspection-after
./buddy inspection:compare /tmp/new-inspection-before/recording.json /tmp/new-inspection-after/recording.json
./buddy inspection:review /tmp/new-inspection-before/recording.json --id review-one --capture capture-0001 --reviewer operator-one --reviewed-at 2026-10-18T12:00:00.000Z --decision needs-follow-up --modality visible --x 48 --y 36 --note 'Operator observation on synthetic example' --output /tmp/new-inspection-reviewed
```

Open `/inspection` to run scenarios, select actual recorded images, inspect camera/quality metadata,
record an explicit local review and compare a second visit with wind. Workspace reviews stay in the
current analysis session and remain attached to their original visit. Native review export persists
them in a new private dataset. It preserves the original source and optionally accepts `--reviews`
to validate and retain an existing `reviews.json` array. Commands also run in the standalone binary
outside the checkout.

## Asset, plan and clearances

The selected asset is one finite, vertical, south-facing bridge face. Face coordinates U=east,
V=up and normal=south are declared as `EAST_UP_SOUTH`. Positions and vehicle quaternions use a
fixed WGS84-origin LOCAL_NED frame with down positive. A revision identifies the registered asset
geometry. Registration is synthetic or operator-declared; there is no authenticated physical scan.

The default face is 1.6 m wide by 1.2 m high, centered at N=3, E=0, D=-1.8 m. Three stations at
U=-0.5, 0, +0.5 m keep the vehicle center 2 m south of their target points. The forward camera
lever is 0.04 m toward the asset, so its nominal optical stand-off is 1.96 m. Its synthetic
pinhole calibration has independent held-out optical/body correspondences and 96 by 72 output.

`createInspectionPlan` validates reference, camera, station, resource and power assumptions, then
compiles takeoff, station waypoint/loiter pairs, return and land into the existing mission graph.
At most three stations fit its retained graph/endurance limits. Every straight segment, including
launch, return and landing, is checked against the finite face and outward half-space. Clearance
inflation includes minimum separation, body radius, declared position/motion envelopes, reaction
distance and braking distance. These declared assumptions do not establish an aircraft's measured
stopping performance. The physics fixture requires origin 0,0,100; other explicitly valid plan
origins remain planning/replay inputs until a matching world is supplied.

Runtime range packets contain three modeled face corners in BODY_FRD. Only the qualified estimated
capture pose transforms them into a measured face center/normal, checking width, height, orientation,
freshness, registration displacement, uncertainty and stopping margin. Plant truth produces raw
synthetic range and image observations. It never supplies capture metadata or mission position.
`minimumObservedSeparationM` is a separate simulation truth diagnostic: normal body-to-face distance
after body radius. It is not the policy range or a physical clearance measurement.

## Captures and image quality

A settled station loiter can issue one shutter command. Its session, sequence, estimator reference
and issued/captured epochs must match an ACK within 80 ms. There is one pending command and no retry
after an uncertain result. Mapping and inspection use the same owned modeled shutter protocol with
different renderers. Confirmed images retain their exact capture-time position, gyro-predicted
attitude, source epochs, calibration, uncertainty, asset observation and motion quality inputs.

Visible pixels come from calibrated rays intersecting the finite modeled face. A separate ideal
temperature field produces numeric uint16 centikelvin values; zero is background/nodata. These are
neither RGB intensities nor calibrated measurements from a thermal instrument. Emissivity,
reflected background, atmosphere, NUC and NETD are unmodeled. The preview uses one fixed 20..40 C
colour scale across visits. Physical radiometry needs its own qualified instrument and correction
inputs, as described in [FLIR's radiometry guidance](https://oem.flir.com/learn/thermal-integration-made-easy/radiometry-with-lepton/).

Capture qualification recomputes calibrated pixel-to-face GSD, exposure-time translation/rotation
blur, asset pixel fraction, station offset, incidence and pose uncertainty. A confirmed image may
still be unqualified; flight completion alone does not establish inspection coverage or defect
visibility. The default nominal run collects three qualified images and lands in about 30 virtual
seconds. The face texture and heated patch are analytic landmarks, not automatic defect detections.

## Recording and explicit operator review

The browser-safe recording module strictly bounds and detaches input, recomputes the plan, replays
the compact mission decisions and joins captures to running station loiters with identical position
epochs. It checks shutter scope, pose timing, array dimensions, thermal values and recomputable
quality. Limits include 64 captures, 65,536 pixels per image, 64 MiB raw imagery, 8 MiB recording JSON
and 16 MiB manifest JSON. Typed pixels serialize to numeric arrays and reload with strict range
checks. Malformed JSON errors omit private source snippets.

The compact trace does not contain every raw sensor or attitude observation. Its validation proves
decision and declared pose-epoch consistency, not full sensor replay or producer authenticity.
Consistently edited unsigned records are not authenticated evidence.

`createInspectionReview` requires an explicit lowercase reviewer identity, canonical UTC timestamp,
decision, note, modality and integer output pixel. Pixel labels refer to the pixel center
`[x+0.5, y+0.5]`, matching raster rendering. Background pixels and rays outside the measured face
are rejected. The review retains face U/V coordinates and a SHA256 binding of the complete capture
metadata, configuration, RGBA and little-endian thermal bytes. Source changes invalidate that
binding. Reviewer identity is operator-declared and `physicalDefectVerified` stays false. The
framework does not fabricate human reviews or diagnose defects.

## Repeat visits and failures

`compareInspectionVisits` requires distinct visit identities, identical asset revision/geometry,
origin, station coordinates, calibration/exposure and compatible quality semantics. It pairs station
captures, retains missing/unqualified stations, and reports camera displacement, view angle,
conservative uncertainty additions and GSD ratio. The comparison limits are 0.5 m offset upper,
0.35 rad view-angle upper and 1.25 GSD ratio. These are explicit fixture comparability tolerances,
not a registration or inspection standard. Pixel differences are not interpreted as deterioration;
`defectChangeDetermined` is always false.

The authored GNSS dropout and structure movement are transient; healthy data returning does not
revive collection. GNSS loss and RC override block, while movement, camera loss, wrong ACK and
operator abort terminate collection. Wind enters actual rigid-body dynamics and changes the route
and images. Pause/resume uses explicit operator actions. Every terminal fixture revokes modeled
outputs. Abort at height is not a controlled emergency landing. A run ending before an authored
fault cannot count as a successful CLI fault demonstration.

## Private export and remaining acceptance

`writeInspectionDataset` exports lossless visible PNGs, raw little-endian uint16 thermal fields and
their metadata, `recording.json`, `reviews.json`, `quality.json`, and per-file hashes in
`manifest.json`. The shared artifact writer snapshots bytes, uses new private directories/exclusive
files and syncs content/directory entries before publishing the completion manifest. Partial outputs
without that marker are incomplete. Local hard-link/directory-fsync support and operator-controlled
parents are required; storage hardware power-loss behavior is untested.

Issue [#20](https://github.com/stacksjs/drone/issues/20) remains open for registered real asset models,
measured range/pose/visible/thermal calibration, qualified camera/payload hardware, environmental
and dynamic-structure campaigns, human-reviewed real defect evidence, richer assets/occlusions,
HIL and vehicle acceptance. This workflow is owned physics simulation, not an external firmware
SITL run or a completed physical infrastructure inspection. See [ADR 20](adr/0020-asset-inspection.md).
