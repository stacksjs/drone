# Selected-vehicle antenna tracking

The owned antenna planner computes bounded pan/tilt trajectories for one explicitly selected
telemetry target. It is simulation-only. There is no physical mount driver, actuator endpoint or
flight-authority path. Issue #16 remains open for measured mount accuracy and link correlation.
The decision is recorded in [ADR 16](https://github.com/stacksjs/drone/blob/main/docs/adr/0016-antenna-tracking.md).

Run the native Stacks command:

```sh
./buddy antenna:bench
./buddy antenna:simulate --scenario target-loss --seconds 12
./buddy antenna:bench --scenario cable-limit
./buddy antenna:bench --scenario manual
bun test tests/unit/antenna.test.ts
```

`antenna:simulate` is an alias of `antenna:bench`. Duration is an integer from 10 to 60 seconds.
Scenarios are `nominal`, `target-loss`, `replay`, `wrong-session`, `clock-reset`, `cable-limit`,
`manual`, `emergency`, `poor-link` and `stale-fix`. Reports include the selection, calibration,
declared model, pointing metrics, modeled link correlation, first fault, final directive and
bounded 100 ms trace samples. They always report `physicalActuationEnabled: false`.

## Reference and calibration

`resources/functions/drone/antenna/index.ts` exports `antennaPointing`, `unwrapPan`,
`validateAntennaConfig`, `createAntennaTracker` and `runAntennaBench` with their public types.
Supply a fixed surveyed WGS84 origin using ellipsoidal height, never an unconverted MSL altitude.
Reuse `estimation/frames.ts` for ECEF and fixed north/east/down. The antenna projection returns
the same vector plus east/north/up, azimuth clockwise from true geodetic north, positive-up elevation
and slant range. Earth curvature is retained. Coincident and near-vertical singular directions stop.

The local axes and azimuth/elevation convention follow the equations in
[ESA Navipedia's ECEF/ENU reference](https://gssc.esa.int/navipedia/index.php/Transformations_between_ECEF_and_ENU_coordinates).
The equatorial equal-height chord test has an independent analytic elevation of minus half the
longitude difference, including a dateline crossing. Heading is true north, not magnetic north.

`AntennaConfig.calibration` requires an identifier, the true azimuth at mechanical pan zero,
the elevation at mechanical tilt zero and surveyed spatial accuracy. The mount must be level;
arbitrary roll/pitch misalignment is unsupported. Desired mechanical pan subtracts the true-north
zero and unwraps against the modeled current pan. Desired tilt subtracts the elevation zero.
Physical north/elevation calibration error and encoder error are not estimated by this model.
The reported pointing uncertainty propagates position and survey distance uncertainty only.

Travel and cable limits are independent. A pan of 361 degrees can represent true azimuth 1 degree
on a multi-turn mount, but cable twist is measured from a declared neutral mechanical angle.
The planner stops if the nearest continuous solution violates either limit. It never switches
to a longer path to unwind. Manual rewinding is an explicit bounded operator action.

## Authority, telemetry and clocks

Construct `createAntennaTracker(config, monotonicNow)` with one nonnegative local clock. The initial
mechanical position is a simulation input, not a verified encoder observation. The lifecycle is:

1. `selectTarget({ targetId, telemetrySessionId })` records an explicit selection and stays disabled.
2. `ingest(qualifiedTelemetry)` validates and copies one sample without enabling motion.
3. `engage()` explicitly admits tracking from the disabled state with a fresh sample.
4. `tick()` emits a trajectory or a stop directive. Call promptly within `maxTickGapMs`.
5. `stop()` disables, clears the target and requests zero software velocity.

The telemetry contract includes a pinned source session/boot, safe increasing sequence, increasing
capture epoch, clock-domain identity, clock uncertainty, geodetic coordinates, horizontal/vertical
position accuracy, and timestamped RSSI/SNR/packet-loss observations. GNSS and link epochs may
differ, but both must use the declared local clock and pass freshness. The planner stamps receipt
time itself. Upstream adapters must authenticate/decode the source, reject replay and map remote
epochs into this clock before calling `ingest`. Merely copying a clock-domain string does not
qualify a physical transport. No such physical telemetry-to-antenna adapter is implemented here.

Unknown vehicles cannot replace the selection. A selected source reboot, replay or malformed fix
stops tracking. Stale/future/uncertain data, poor or stale link observations, range and angular
uncertainty violations also stop. A bounded 16-stream replay ledger persists across stop, manual
override and reselection. Sequence wrap or ledger exhaustion requires a newly supervised tracker
session; old entries are never silently evicted. Timestamps may not repeat even if sequence rises.

Faults latch: receiving good data does not resume motion, and `engage()` cannot clear a fault.
The operator must select again, supply a newly admitted fix and engage. `manual(angles, leaseMs)`
interrupts tracking with explicit mechanical angles within the same limits. Its lease is at most
one second and must be renewed; expiry stops and requires explicit recovery. `emergencyStop()`
latches independently of selection or manual input. `resetEmergency()` clears it into disabled,
then selection and engagement must be repeated. No path automatically reacquires a target.

Normal trajectory velocity and acceleration are bounded separately on each axis. An emergency,
override or fault may set commanded velocity to zero immediately. A software stop is not evidence
of a physical brake, hold torque, power-loss response or stopped antenna. The lagged bench mount
continues settling after the planner stops issuing trajectories.

## Evidence and the physical gate

The default 12-second simulation uses a moving 600 m slant-range target, 10 Hz telemetry with
40 ms position latency, a 20 ms planner tick, and a modeled 100 ms mount lag. Geodetic measurements
come from an independent inverse ECEF sensor synthesizer. Accuracy is scored against the original
local N/E/U truth vector, without calling the production pointing solver for expected angles.
The first two seconds are excluded from accuracy scoring, and the reported modeled tolerance is
3.5 degrees. The retained default run has about 3.07 degrees maximum error and 1.94 degrees RMS
error. These are model results, not a mount specification.

RSSI uses the declared synthetic pattern `-45 - 0.04 * angularErrorDeg^2`. Correlation with squared
error is consequently negative one by construction, not RF validation. `linkErrorDeg` is the
pre-motion error paired with that modeled RSSI; `errorDeg` is the post-step mount error. Live
policy also gates reported SNR and packet loss, but it does not search for a signal maximum or
use RF measurements to select a different vehicle. Fault scenarios report zero trajectory commands
after the first latched stop. Neither this count nor the synthetic RF curve proves physical safety.

Before a physical adapter can be enabled, retain measured evidence for:

- Surveyed origin/datum/height, mount level and true north/elevation zero with error budgets.
- Encoder polarity, scale, backlash, closed-loop position, hard stops, cable neutral and travel.
- Independent manual/emergency/power-loss stop behavior and measured braking distance/latency.
- Authenticated source selection, boot identity, clock mapping, fix age, replay and link loss.
- Timestamped independent pointing-angle truth across wrap and near travel limits, paired with
  measured RSSI/SNR/packet loss at the same epochs and calibration identifiers.

Keep simulator, bench, HIL and vehicle evidence separate. Camera payload bus declarations and
acknowledged external-driver protocols do not constitute an antenna actuator implementation.
