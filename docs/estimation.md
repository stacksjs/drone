# Owned estimator

Issue [#4](https://github.com/stacksjs/drone/issues/4) has a replayable first estimator built on the
owned [sensor stream](sensors.md). This is a Pi/Bun TypeScript bench implementation, not a board-rate
flight estimator. Issue #3 remains open for physical capture, calibration and timing evidence.

## Native Stacks CLI and library

```sh
./buddy estimator:replay tests/fixtures/estimation/motion-v1.json --at-ms 6040
bun run runtime:cli
./storage/runtime-build/cli/drone estimator:replay tests/fixtures/estimation/motion-v1.json --at-ms 6040
bun tests/fixtures/estimation/evaluate.ts
```

Buddy and the standalone executable share `defineCommand()` from `@stacksjs/cli`. Files are bounded
at 1 MiB before parsing; input uses the same sensor dataset/anchor/calibration schema. No command
opens a physical transport. The library functions and public types live in
`resources/functions/drone/estimation/`.

```ts
import { createEstimatorReplay } from './resources/functions/drone/estimation/replay'
import { createSimulator } from './resources/functions/drone/simulator'

const replay = createEstimatorReplay(dataset)
const { estimate } = replay.advanceTo(1000)
const sim = createSimulator({ estimatorReplay: createEstimatorReplay(dataset) })
```

Attach one fresh sensor or estimator replay, starting at zero. Every accepted/rejected sensor event
and anchor refresh reaches the estimator in receipt order. Large playback steps produce the same
result as fine steps, and pause freezes playback. The simulator's `estimate` and `sensors` fields
are diagnostic; its ideal kinematic `telemetry` and behavior decisions remain separate.

For a live application, `createEstimator({ origin? })` exposes `update(sensorSnapshot)`,
`snapshot(monotonicMs)` and `reset(monotonicMs)`. Update accepts qualified output from
`createSensorPipeline().snapshot()`, including its boot token and clock. A snapshot advances the
consumer clock, so later input cannot be older than that snapshot. Use one receipt-ordered consumer.
Retained samples update mapped epochs and expiry after clock refreshes without being integrated twice.
Output is cloned; caller mutations cannot alter state. Events retain the latest 20 reset reasons.

## Attitude convention and observability

The unit Hamilton quaternion is `[w,x,y,z]` and rotates BODY_FRD vectors into a gravity-aligned
reference with arbitrary initial yaw. It is explicitly `GRAVITY_ALIGNED_RELATIVE_YAW`, not a
north-referenced quaternion. Positive body angular rates follow the right-hand rule. Euler output
uses roll/pitch/yaw in radians with `Rz(yaw) Ry(pitch) Rx(roll)` convention. Euler angles are diagnostic
and singular at pitch ±90 degrees; use the quaternion for orientation arithmetic.

Initialization needs at least 20 consecutive samples spanning 380 ms: gravity norm within 5%,
angular speed below 0.1 rad/s and acceleration changes within 0.1 m/s². This is an apparent-rest
heuristic, not proof that linear acceleration is zero. Calibrated gyro samples then propagate the
quaternion using the exponential of body rate. Propagation, gap checks and alignment duration use
board-monotonic capture-time deltas, so a host clock-anchor correction cannot add a false rotation. A proportional cross-product correction (gain
2 /s) aligns predicted down with negative measured specific force while its norm is within 15%
of standard gravity. Outside that range, gravity correction is suppressed and flagged.

There is no compass or other heading observation in the sensor profile. Absolute yaw and its
covariance cannot be inferred from gravity or assumed from GNSS course. `absoluteHeading` and
`navigation` stay false. Relative yaw drifts with residual gyro bias; a 0.02 rad/s bias gives 0.08 rad
drift over four seconds in the test. Attitude covariance is null. An optional `gravityCorrection: 'initialization-only'` disables post-alignment gravity feedback
for the explicitly assumed-heading [control physics experiment](controls.md). The default remains
`norm-gated`. This mode is gyro propagation, not a remedy for physical observability or bias drift.
No gyro bias learning, coning
correction, accelerometer dynamic rejection beyond the norm heuristic, Earth-rate or lever-arm
model is claimed.

## Fixture IMU-aided prediction

The optional `createEstimator({ gravityCorrection: 'initialization-only',
positionPrediction: 'fixture-imu' })` mode is confined to synthetic fixture evidence. It
assumes the initial relative-yaw frame points north; it does not observe absolute heading or
qualify physical inertial navigation. Handshake evidence is rejected. The normal estimator
and existing profiles keep constant-velocity prediction.

This mode rotates qualified calibrated specific force through the estimated attitude, adds
gravity and propagates the three position/velocity blocks between GNSS corrections. It retains
the actual GNSS capture epoch separately from prediction time. Repeated sensor refreshes do
not integrate a sample twice. Its bounded history holds at most 128 samples, with a 50 ms
IMU interval limit, 80 ms IMU age limit, 1.5 second GNSS age limit and at most 1 ms declared
epoch uncertainty. This mode requires a fixed capture-to-local epoch mapping; retiming
retained samples withdraws prediction and changes its reference. Vehicle controllers retain
their stricter freshness limits.

Process variance combines calibrated force variance with an assumed 0.03 rad attitude error.
The acceleration error is held across each GNSS prediction interval rather than treated as
independent on every IMU sample. These are fictional model assumptions, not measured attitude
covariance or validated error bounds. Cross-axis correlations, bias learning and physical heading alignment remain unqualified.
The `fixture-imu-v1` constants appear in the planned VTOL case's navigation evidence.

IMU loss or malformed dense vectors withdraws inertial position without falling back to a
fresh-looking constant-velocity result. A new GNSS fix after unavailable inertial history may
initialize a new position reference. The reset counter changes, so a controller bound to the
previous reference cannot silently resume.

## Local position, height and covariance

WGS84 latitude/longitude and **ellipsoid** height convert through ECEF to a fixed local NED tangent
frame. Origin is explicit configuration, or the first qualified GNSS fix. North/east/down are metres;
velocity is m/s. MSL height is never substituted for ellipsoid height. Fix-local velocity axes are
rotated into the origin's NED axes, including near poles and across longitude changes. The origin
persists through resets; create a new estimator to establish a different frame. Fixes beyond 5 km
from the origin are rejected rather than silently rebasing.

By default, the GNSS filter uses independent `[position, velocity]` blocks for N/E/D with constant-velocity
prediction and assumed acceleration standard deviation 2 m/s². Each correction uses sensor-reported
position/velocity variances. Rotation keeps their diagonal terms; cross-axis correlations are
ignored. Returned blocks include position variance, position-velocity covariance and velocity
variance. This is model-dependent approximate covariance, not validated error bounds or a tightly
coupled inertial EKF. The default and physical receive-only path do not integrate accelerometer data into translation while heading is unobserved.

A sum of normalized position and velocity innovations above 36 rejects the entire fix and
invalidates position health until a later accepted fix. The gate uses marginal variances, not the
full correlated innovation matrix. Stale predictions stop at 1.5 seconds; health expires using the
sensor's upper measurement age. A fresh fix after a >1.5 second measurement gap reinitializes the
blocks, increments the position reset counter and records `gnss-reacquired`, preserving origin.

Pressure height uses `44330 * ((pressure / initialPressure)^0.190294957 - 1)` metres down relative
to the first qualified sample. It has a separate `PRESSURE_RELATIVE_INITIAL` datum. Weather,
temperature and pressure reference error are not modelled; its variance is null. It is not fused
into ellipsoid/NED position, and its independent freshness limit is 300 ms.

## Health, reset and failure behavior

Each output has separate health. Tilt needs fresh qualified BODY_FRD IMU and positive finite noise
variances. Position needs qualified GNSS with a known measurement epoch and accuracy. `healthy`
from a transport alone cannot override an unknown age, unvalidated timing, pending overrun or
stuck source. Fixture calibration cannot qualify a handshake/physical source. Physical-flight
capability is always false.

IMU gaps over 50 ms, capture reversal, replay, changed mount/calibration, unhealthy samples or
board restart require fresh apparent-rest alignment. Resuming packets during motion does not silently restore
attitude health. Reset counters make the new arbitrary yaw
reference visible. GNSS outliers do not silently move the state; reacquisition and identity changes
record position resets. Board restart clears attitude, position and pressure reference; explicit
operator reset clears them too. Both keep the fixed geodetic origin. Clock reversal clears state
and throws; the consumer clock cannot be rewound. Missing compass keeps heading unavailable rather
than selecting another person, using course as yaw or publishing a fabricated heading.

## Evidence and remaining work

The independently encoded six-second fixture starts with one second at rest, then coupled analytic
Euler motion and constant NED velocity. It includes quantized raw registers, known synthetic GNSS
epochs, UART serialization and a clock refresh. `generate.ts` imports no estimator/codec. The truth
is analytic, not a real vehicle log. GNSS motion uses independent equatorial WGS84 curvature radii.
The published GeographicLib CartConvert ECEF/local example and simple equatorial NED axes test frame/datum
conventions. No physical orientation reference, compass, RTK or vehicle flight is validated.

Regenerate fixtures with `bun tests/fixtures/estimation/generate.ts`; reproduce maximum/RMS errors
with `bun tests/fixtures/estimation/evaluate.ts`. The [retained report](https://github.com/stacksjs/drone/blob/main/docs/estimator-evidence.json) is
specific to this scripted trajectory. Its small errors are not a claim about sensor/vehicle accuracy.
Tests additionally inject IMU outage, stale/replayed/time-reversed input, mounting/noise errors,
GNSS jumps/reacquisition, gyro yaw bias and datum changes, and check covariance positivity.

Remaining acceptance and progression within #4:

1. Finish #3 hardware timing/calibration and #2 watchdog/deadline evidence. Retain reference
   orientation/position captures and quantify normal/failure error against independent instruments.
2. Add calibrated compass or dual-antenna GNSS/vision heading with frame, declination, disturbance,
   innovation and yaw-reset tests. A compass failure must invalidate heading without fabricated yaw.
3. Introduce a full-covariance error-state EKF: attitude, position, velocity, gyro/accelerometer
   biases, process models, observability, stable covariance updates and reproducible Monte Carlo tests.
4. Add PPS-aligned GNSS epochs, delay history and out-of-sequence updates; tie barometric reference
   to a declared ellipsoid/geoid datum before vertical fusion. Validate resets and discontinuities.
5. Add optical flow with range/scale quality, calibrated camera-to-body VIO transforms and delay,
   RTK fix/ambiguity/baseline quality, then multi-IMU/GNSS redundancy with fault isolation.
6. Propagate full-rate anti-aliased IMU delta angles/velocities with coning/sculling handling. Port
   a validated bounded implementation into the native scheduler and measure stack and deadlines.
   Only then consider estimator-backed controls in #5 and authority in #6.

References: [IOGP/EPSG Guidance Note 7-2](https://www.iogp.org/bookstore/product-tag/373-07-2/),
[GeographicLib LocalCartesian](https://geographiclib.sourceforge.io/html/CartConvert.1.html),
[IMU conventions, REP 145](https://www.ros.org/reps/rep-0145.html),
[Mahony, Hamel and Pflimlin, complementary filter design](https://doi.org/10.1109/CDC.2005.1582367).
These establish mathematical/frame context; this implementation is original and is not a complete
implementation or validation of every algorithm in those references.
