# ADR 5: Owned multirotor feedback in a separate physics harness

Status: accepted first software slice of issue #5.

## Decision

Implement original TypeScript position, velocity, attitude and body-rate feedback plus quad-X
allocation in `resources/functions/drone/controls/`. Exercise it in a deterministic six-degree
rigid-body model, through modeled raw sensor frames, the existing sensor pipeline and our estimator.
Native Stacks owns `controls:simulate`, CLI packaging and read-only capability reporting.

The controller accepts only a simulation context and fixture-backed estimates with fresh tilt,
position and matched body-rate epochs. It never reads plant truth. A separate evaluator uses plant
truth for error/response metrics. Outputs are per-motor **simulated thrust in newtons**, not PWM,
DShot, ESC commands or an adapter with physical authority. Board outputs remain inhibited.

## Estimator assumptions

The world starts with exactly zero yaw. `initial-simulation-north` declares the relationship between
relative estimator yaw and the modeled NED frame. It is not a north observation. Absolute-heading
and navigation health in the estimator remain false.

The existing gravity-norm correction cannot distinguish sustained translation from tilt. Add an
explicit `initialization-only` option, preserving `norm-gated` as the estimator default. This harness
uses supported apparent-rest alignment for 600 ms, then propagates calibrated gyro rates without
accelerometer tilt correction. Noise is deterministic quantization/dither and no measured bias is
claimed. This is a limited simulation experiment, not a fix for physical heading/attitude observability.

## Control and model boundaries

Use bounded cascaded loops, derivative on measurement, conditional integration, tracking feedback
for vector/actuator limits, thrust clipping and per-motor slew. Allocation reports achieved wrench
so rate-integral tracking sees constrained commands. It does not measure actual motor thrust.

The plant uses invented mass/inertia, first-order motor lag, linear drag/wind and rigid-body
Newton/Euler equations. It has a simple vertical floor constraint, not a landing/contact dynamics
model. IMU loss latches zero simulated commands; the model can fall. Do not report that as landing.

Keep the previous ideal kinematic simulator and external drivers unchanged. The [control guide](../controls.md)
records scenarios, equations, gains, evidence and the continuation path to measured tuning, native
bench execution, autotune and other vehicle/control variants. Physical output waits for #6 authority
validation and the remaining #2/#3/#4 hardware and estimator work.
