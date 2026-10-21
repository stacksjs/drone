# Simulated owned multirotor controls

Issue [#5](https://github.com/stacksjs/drone/issues/5) now has a first closed-loop physics harness:
owned position/velocity/attitude/rate feedback, quad-X allocation, raw simulated sensors and the
owned estimator. No ArduPilot/PX4 process, hardware command or external control implementation is used.

## Native Stacks entrypoints

```sh
./buddy controls:simulate --scenario hover --seconds 20
./buddy controls:simulate --scenario step --seconds 20
./buddy controls:simulate --scenario wind --seconds 20
./buddy controls:simulate --scenario delay --seconds 20
./buddy controls:simulate --scenario imu-loss --seconds 8
bun run runtime:cli
./storage/runtime-build/cli/drone controls:simulate --scenario step --seconds 20
bun tests/fixtures/controls/evaluate.ts
```

The command uses `defineCommand()` and shares its implementation between Buddy and the standalone
executable. Duration is an integer 2..60 seconds; additional sensor delay is bounded 0..200 ms.
Output is JSON with model assumptions, response metrics, final truth/estimate/control and a bounded
200 ms trace. The trace is evaluation output; the controller receives only estimates and sensor rates.
The source lives under `resources/functions/drone/controls/`. No database, network or physical IO is
needed. The previous ideal follow simulator and external flight adapters are separate.

## Declared simulation assumptions

The invented vehicle is 1.5 kg with diagonal inertia [0.03, 0.03, 0.05] kg m², 0.16 m X/Y arm
projections, 0.02 m yaw reaction coefficient, 10 N maximum thrust per motor, 40 N/s command slew,
40 ms motor time constant, linear drag 0.4 kg/s and angular drag 0.01 N m s. These values are not
measurements of a purchased kit. `multirotorModel` is immutable.

The initial position is NED [0,0,-1] m with zero velocity, identity quaternion and zero motor thrust.
A stationary support holds the model until 600 ms, allowing the estimator to align. After release,
all force/torque integration comes from constrained motor commands and specified disturbances.
Motor spool-up is part of the measured response.

The world starts with yaw zero. The controller explicitly declares `initial-simulation-north` so
relative estimator yaw can be related to this synthetic NED frame. Estimator `absoluteHeading` and
`navigation` remain false; this relationship must never be inferred for a physical vehicle.

The estimator's default gravity-norm correction remains unchanged for existing callers. The harness
selects `gravityCorrection: 'initialization-only'`: apparent-rest alignment followed by gyro
propagation. Accelerometer gravity-norm correction alone cannot distinguish translational force
from tilt. This harness does not solve that problem, gyro bias drift or heading observability.

## Physics and sensor path

At 250 Hz by default (4 ms), or 500 Hz for a convergence check, the model integrates:

- Motor thrust lag: `f += (command - f) * (1 - exp(-dt / 0.04))`.
- Body angular acceleration: `I^-1 * (torque - omega cross (I omega) - angularDrag * omega)`.
- Unit quaternion propagation by the exponential of body rate.
- NED acceleration: gravity plus rotated [0,0,-totalThrust]/mass, external force and linear drag
  relative to wind velocity. Semi-implicit velocity/position updates follow.

BODY_FRD is forward/right/down; NED is north/east/down. Quaternions are Hamilton [w,x,y,z], rotating
body into world. A simple vertical floor stops penetration. It does not model landing gear,
restitution, friction, body geometry or rotor-ground interaction.

The model produces 50 Hz raw ICM-format IMU and 10 Hz NAV-PVT-format GNSS records. Specific force
is `R^T * (acceleration - gravity)`, not a gravity-only oracle. The sensor pipeline applies actual
raw conversion, calibration, clock, age and quality checks. GNSS uses equatorial curvature radii
around a fixed WGS84 origin (0 degrees, 0 degrees, 100 m ellipsoid height); it is a small-area synthetic
model. The estimator then supplies attitude, filtered GNSS NED position and velocity.

Timing is known and synthetic: 4 ms base delivery plus configured additional delay, released on
physics ticks. This does not model UART bandwidth/serialization. Capture times remain distinct from
receipt times. Anchor refreshes use the owned sensor clock contract. At most 32 delayed frames are
retained. IMU has deterministic one-count dither/quantization; GNSS is quantized. No measured noise,
random bias, vibration, multipath, PPS alignment or hardware accuracy is represented.

## Cascaded controller

Feedback runs at 50 Hz. `createSimulatedMultirotorController({ headingAlignment })` accepts a
`SimulatedControlInput` and returns `simulated-control` output. Its motor values are **newtons in
this model**, never normalized ESC/PWM values. It has no transport or physical adapter.

| Loop | Input and output | Nominal bounds/gains |
| --- | --- | --- |
| Position P | NED position error, m, to velocity demand, m/s | gain 1 /s; horizontal norm 3 m/s, vertical 2 m/s |
| Velocity PI | velocity error to NED acceleration, m/s² | Kp 1.6 /s, Ki 0.25 /s²; integral 1.5 m/s²; per-axis 3 m/s² then horizontal norm/tilt limit |
| Attitude P | shortest body quaternion error to body-rate demand, rad/s | quaternion-vector gain 8 /s (small-angle gain 4 /s); roll/pitch 3 rad/s, yaw 1.5 rad/s |
| Rate PID | body-rate error to torque, N m | Kp [0.12,0.12,0.08], Ki [0.08,0.08,0.04], Kd [0.002,0.002,0.001]; torque limits [0.6,0.6,0.25] N m; integral 0.12 N m |

Rate PID gains carry the units needed to convert rad/s, its integral and derivative into N m.
The derivative is on measured rate, with a 30 ms first-order filter, avoiding a setpoint derivative
kick. Conditional integration prevents the local output cap from accumulating outward error.
Velocity integral tracking uses the constrained acceleration-vector residual, gain 1 /s. Rate
integral tracking uses achieved-command torque minus requested torque, gain 4 /s. Integrals remain
bounded and clear on disable/inhibition. This does not estimate actual motor lag or implement full
collective-thrust tracking anti-windup in the velocity loop.

Acceleration and declared yaw determine desired thrust direction and attitude. Maximum requested
tilt is 25 degrees. Collective thrust is mass times the norm of gravity-minus-acceleration. The
actual tilt can exceed a setpoint limit during transients; tests separately bound modeled attitude.

## Quad-X allocation worked cases

Motor order is front-right, rear-right, rear-left, front-left. Positions are BODY_FRD
[(+d,+d),(-d,+d),(-d,-d),(+d,-d)] with d=0.16 m. Each produces negative body-Z force. Reaction yaw
signs are [+,-,+,-], defined as body torque, not a vendor ESC/motor numbering convention.

For motor thrusts [a,b,c,d4] N, total thrust is their sum. Moments are
`0.16*(-a-b+c+d4)`, `0.16*(a-b-c+d4)`, `0.02*(a-b+c-d4)` N m. The inverse produces requested motor
thrusts, then clips each to [0,10] N and applies 40 N/s slew. It reports achieved wrench and whether
commands were constrained. There is no priority desaturation, QP allocation or failed-motor control.

Independent cases in tests:

| Motors, N | Collective, N | Roll/pitch/yaw torque, N m |
| --- | --- | --- |
| [5,5,5,5] | 20 | [0,0,0] |
| [4,4,6,6] | 20 | [0.64,0,0] |
| [6,4,4,6] | 20 | [0,0.64,0] |
| [6,4,6,4] | 20 | [0,0,0.08] |

Hover requires mass*g = 14.709975 N. Independent free-fall and roll-moment cases also verify NED
and inertia signs. Motor clipping/slew are tested apart from the physics loop.

## Inhibition and estimator resets

Only fixture-backed estimates in an explicit simulation context qualify. The controller requires
fresh healthy tilt/local position, a normalized quaternion, the expected frame/datum, matched IMU
rate/attitude epochs, fresh target commands and a valid control interval. Estimator health must be evaluated at the current control tick, not reused from an older snapshot.
Limits are 60 ms attitude/rate capture age, 200 ms GNSS/target age and a control step of 5..40 ms.

After feedback starts, lost health, changed boot/origin/reset counters, unmatched epochs, invalid
values, stale/future targets and schedule/clock faults latch inhibition. `reset()` or an explicit
disabled step clears that session; fresh observations must qualify again. Startup can wait for
qualified estimates. A fault produces immediate zero simulated commands, bypassing normal slew;
it is not a landing or RC stick controller. The separate [authority harness](authority.md) adds explicit lifecycle supervision. The physical firmware remains neutral-only.
Every output retains `physicalFlightEnabled: false` and `boardOutputsInhibited: true`.

## Scenarios, evidence and continuation

The [retained report](https://github.com/stacksjs/drone/blob/main/docs/controls-evidence.json), regenerated by `tests/fixtures/controls/evaluate.ts`,
records 20-second hover, 2 m north/1 m east/0.5 m climb step, wind/disturbance, delay and IMU-loss runs.
Wind starts at 5 s, [4,-2,0] m/s, and torque disturbance [0.03,-0.02,0.01] N m lasts 7..7.4 s.
Delay adds 20 ms to source delivery. Actual successful control IMU ages are reported separately.
IMU loss stops captures at 3..3.4 s; zero commands remain latched when capture resumes.

Settling is the first 200 ms trace sample after the step (or after disturbances) where position error
remains below 0.2 m for the rest of the run, with at least one second of remaining trace. Tail RMS
uses the last two seconds. Peak error, tilt, rate, slew, constrained ticks and ground contact are
reported separately. Reported slew covers enabled commands; inhibition bypasses the normal limit.
Finite-step convergence is checked with 2 ms versus 4 ms physics integration.
The numerical values apply only to this declared model and sensor assumptions.

To complete #5 and advance beyond this slice:

1. Finish #2/#3/#4 physical timing, calibration, heading and estimator validation. Add biased/noisy
   sensors, GNSS loss, jitter, vibration, asynchronous rates and Monte Carlo/parameter sweeps.
2. Validate full-rate attitude/rate bandwidth and motor/ESC calibration. Add thrust/battery/propeller
   nonlinearities, aerodynamic coupling, delay distributions, priority allocation and collective
   anti-windup. Measure stability margins and compare an independent higher-fidelity model.
3. Port bounded loops to the native scheduler and disabled-prop harness. Keep outputs inhibited
   until #6 supplies independently validated authority, RC override, kill and reset/failsafe behavior.
4. Add recorded manual tuning and guarded identification/autotune, then validate gain scheduling,
   notch filtering, feedforward, jerk-limited trajectories, disturbance observers, LQR/MPC and
   geometric-control variants against the same failure contract.
5. Treat helicopter swashplate/rotor dynamics, governor and autorotation as separate profiles with
   their own allocation, energy model and independent tests. No quad-X result establishes those.

Mathematical context: [PX4 controller diagrams](https://docs.px4.io/main/en/flight_stack/controller_diagrams)
and [control allocation concepts](https://docs.px4.io/main/en/concept/control_allocation).
The implementation, gains, equations and tests here are original; no upstream controller code is
copied or loaded, and no parity, physical flight or disabled-prop hardware validation is claimed.
