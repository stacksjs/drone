# Aerial survey collection

Issue #18 builds survey planning and image collection on the owned mission runtime. It does not
require ArduPilot or PX4. Open `/mapping` for planned lanes, estimated flight tracks, acknowledged
exposure footprints, playback and the final collection report.

```sh
./buddy mapping:plan
./buddy mapping:plan --config examples/survey.json
./buddy mapping:simulate --scenario nominal --output /tmp/new-survey-dataset
./buddy mapping:simulate --scenario crosshatch
./buddy mapping:simulate --scenario terrain
./buddy mapping:simulate --scenario camera-loss
```

The standalone CLI exposes the same commands outside the checkout. `--seconds` bounds virtual time
and fails if the expected terminal outcome was not reached. The default mission completes in about
55 virtual seconds; crosshatch takes about 95. These are simulator results, not measured endurance.

## Plan and geometric contract

A version 1 configuration declares an unclosed simple polygon and optional disjoint holes in
fixed LOCAL_NED north/east metres, a WGS84 ellipsoidal origin, body altitude above a declared terrain
plane, camera calibration and held-out validation points, front/side overlap, maximum ground sample
distance, heading, speed, shutter timing and power/reserve. The planner clips alternating transects
against concave boundaries and holes. Crosshatch adds a second sweep at heading+90 degrees.

The terrain plane is `D=d0+gradientNorth*N+gradientEast*E`, with gradient magnitude at most 0.1.
Body lane altitude follows this plane at the requested AGL. The camera is a centered nadir optical
RDF mount rotated into body FRD, with a calibrated lever arm. The default optical center is 4 cm below
the body, so body AGL 1.5 m gives camera AGL 1.46 m. Down is positive; ellipsoid height is never AGL or MSL.
Exact fixed-NED/ECEF/WGS84 conversion is used for exported optical-center positions.

Camera geometry shares the Brown5 inverse, explicit crop/scale and held-out validation used by
calibrated target vision. The planner uses a conservative central square and analytic lens derivative
and terrain bounds to constrain GSD and overlap. A crop is applied once. The nadir mounting, image
mode and calibrated depth envelope must be compatible. Unknown fields, unsupported topology,
folding lenses, impossible trigger cadence, excessive GSD and insufficient reserve are rejected.

AOI holes clip imaging lanes. They are not no-fly regions. Connectors can cross holes and complete
image footprints can extend outside the AOI. The owned mission validates every endpoint and straight
connector inside its convex fence. It does not implement obstacle avoidance for this collection run.

Planning limits are 128 total vertices, eight holes and 128 lanes. Execution compiles only plans that
fit the existing 32-task, 120-second quad mission budget and its 12 m radius and 5 m altitude fixture fence.
It rejects unsupported plans before flight simulation rather than silently dropping lanes. The
physics world is fixed at origin 0,0,100; arbitrary valid origins remain available for planning and
coordinate conversion. Terrain is a declared optical surface; the existing flat ground contact model
still owns launch and landing. This is not a general DEM or terrain collision simulation.

## Runtime and exposure provenance

Every collection uses the existing raw wire-like IMU/GNSS feed, owned estimator, versioned mission,
multirotor controls, authority leases and separately ticking modeled board watchdog. The explicit
fixture operator arms and engages; the mapping policy cannot arm. Optional mission speed is bounded
to 0.05..0.6 m/s and recorded in the plan for exact decision replay. Older plans preserve 0.6 m/s.
Launch and landing deadlines cover their commanded distance divided by speed plus two seconds for
tracking and settling. A vertical task needing more than the existing 20-second limit is rejected
before execution. Owned collection requires synthetic calibration and clock uncertainty at most 5 ms;
the generic planner retains its separate calibration capabilities.

Camera triggering uses current estimated travel, a minimum shutter interval and active imaging-lane
scope. One request is pending at a time. A scoped ACK must arrive within 80 ms; no ambiguous shutter
is retried. Accepted records retain request, exposure and ACK times, session/sequence/reference,
calibration ID, pixel dimensions and actual rendered RGBA data. The shutter setting is declared in
microseconds and the timestamp is a synthetic exposure midpoint on the fixture monotonic clock.
There is no UTC conversion or measured hardware synchronization claim.

The deterministic `ned-checker-landmarks` renderer, version 1, has no random seed. It traces calibrated
pixel-center rays against a textured ground plane with fixed red and blue landmarks. Only rendering
consumes plant truth. Geotags use the owned estimator with qualified raw-gyro capture-time prediction,
calibrated lever arm and an explicit initial-simulation-north assumption. The estimator does not
observe absolute heading. Declared attitude uncertainty includes the fixture drift assumption and
35 rad/s times clock error, using the qualified raw-gyro ceiling. Optical-center position uncertainty
sums estimated body covariance sigma, mount translation sigma, speed times clock error, and lever
length times attitude uncertainty. These are retained bounds, not calibrated field accuracy.
Rendering is instantaneous at the midpoint: it does not integrate motion blur or model rolling
shutter. The translation metric divides modeled travel by the planned upper GSD bound. It excludes
angular blur; a small value at that bound does not certify actual image sharpness.

Camera loss, mismatched ACKs, raw IMU/position loss and manual takeover stop collection. Healthy data
returning does not restart it. Cancellation and faults release modeled thrust; this is not an
emergency landing. A truncated run is incomplete even when its modeled board is neutral. Normal
completion requires the owned landing task to finish. Scope/metadata checks cannot authenticate an
unsigned recording against an editor who consistently replaces all inputs.

## Dataset and quality report

A fresh private output directory contains:

```text
images/photo-0001.png
images/...
geo.txt
quality.json
README.txt
manifest.json
```

The exporter checks bounded memory, unique identities, raster/metadata consistency, calibration,
pose/lever/geodetic transforms, capture/ACK timing and trace decisions before IO. It writes images
using the `ts-images` PNG codec and hashes the encoded bytes. Every exclusive image and metadata file
receives an fsync barrier, followed by image/root/parent directory barriers. A synced pending manifest
then receives the exclusive `manifest.json` hard link, and the root directory is synced before return.
Existing directories are never overwritten. A partial directory without a complete manifest is not
a complete export. Parent directories must be operator-controlled. Local hard links and directory
fsync are required; storage hardware power-loss durability has not been tested.

ODM expects an `images/` directory and accepts PNG inputs. `geo.txt` begins with `EPSG:4326`; rows are
`filename longitude latitude ellipsoidHeight`. The manifest separately declares the horizontal CRS,
longitude/latitude ordering, metre units and WGS84 ellipsoid height datum. AGL and MSL are never
substituted for ellipsoidal Z. See the [ODM geo format](https://docs.opendronemap.org/geo/) and
[PNG input extension support](https://github.com/OpenDroneMap/ODM/blob/77439b1f45ceb4775b826f900916c64f03736331/opendm/context.py).
This is format interoperability, not an executed ODM reconstruction campaign.

Full native Brown5/crop/mount calibration remains in the manifest. An ODM camera override is not
emitted because camera identity and conversion need a tested importer. RTK, PPK and GCP status is
explicitly unavailable for every image. No GCP file, fixed solution or carrier-phase observations are
fabricated. Actual GCP export needs independently surveyed coordinates and corresponding image pixels
in a common vertical datum. Geoid conversion and correction processing are not implemented.

The report distinguishes planned coverage/GSD/overlap/endurance from observed captures, timing,
spacing and sampled estimated-footprint coverage. Coverage is a bounded grid estimate of four-corner
footprints, with sampling and distorted-boundary limitations. Collection completeness is not
reconstruction quality, stockpile accuracy, an orthomosaic, or a point cloud. Mission completion can
coexist with quality warnings or an incomplete image dataset.

## Remaining acceptance

Measured Pi optics/mount/ROI/timing, physical shutter and payload ACK integration, GNSS heading and
RTK/PPK/GCP campaigns, real terrain/DEM data, measured battery performance, rolling-shutter/blur
models, HIL/vehicle survey and an actual external reconstruction interoperability campaign remain
open. Stockpile/surface reconstruction and volume measurement belong to issue #19. Physical outputs
remain inhibited. This slice proves owned simulator collection, not safe autonomous physical flight.
