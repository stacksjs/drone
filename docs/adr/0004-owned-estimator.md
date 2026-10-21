# ADR 4: Replayable owned estimator before flight integration

Status: accepted first software slice of issue #4.

## Decision

Implement original TypeScript estimation under `resources/functions/drone/estimation/`, consuming
qualified snapshots from the owned sensor pipeline. Stacks owns command discovery, CLI packaging
and application exposure. ArduPilot/PX4 are not imports, processes or providers for this estimator.
No external firmware or estimator source is vendored.

The first estimator combines three deliberately separate outputs:

- A unit quaternion complementary tilt observer with body-rate integration. Its world reference is
  gravity aligned with arbitrary initial yaw, not north. Absolute heading remains unobservable.
- Three two-state constant-velocity Kalman blocks for fixed-origin GNSS NED position and velocity.
  This is GNSS smoothing/prediction, not inertial navigation or an extended Kalman filter.
- Standard-atmosphere pressure height relative to the first qualified pressure sample. This datum
  is separate from WGS84 ellipsoid height and MSL, so it is not silently fused with GNSS down.

Replay delivers every sensor event in receipt order, including faults and clock refreshes. Caller
playback step size does not discard intermediate IMU measurements. State propagates using capture
epochs. Snapshots age independently, and EOF does not stop the simulator. The simulator exposes
estimates separately from its existing ideal motion/controller telemetry.

## Why this scope

Issue #3's physical calibration, clock and group-delay evidence is still open. The physical IMU
profile flags unvalidated timing, and physical GNSS has no PPS-aligned measurement epoch. Those
samples must remain rejected for synchronized estimation. A new analytic wire fixture supplies
explicitly synthetic known timing and independent truth, allowing useful software work without
inventing hardware evidence.

A 50 Hz decimated telemetry stream with no calibrated compass cannot establish a flight-rate
attitude/heading/position solution. Unknown heading, unmodelled covariance and missing sources stay
visible. There is no adapter to command or flight `Telemetry`, no arming and no actuator output.

## Next decisions

Tightly coupled error-state EKF, bias learning, heading observations, barometric datum alignment,
delay compensation, full-rate IMU propagation, VIO/optical flow/RTK and redundancy require the
reference campaigns and numerical work in the [estimator guide](https://github.com/stacksjs/drone/blob/main/docs/estimation.md). Porting a
validated algorithm into the allocation-free board scheduler is separate from this Pi-side replay
implementation and requires issue #2's measured runtime budgets.
