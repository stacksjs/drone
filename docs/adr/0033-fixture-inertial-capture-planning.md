# ADR 33: qualify planned capture on owned fixture prediction

Status: bounded fixture implementation for issue #87. Physical qualification remains open.

## Decision

The bounded VTOL capture planner uses an explicit fictional `fixture-imu` position prediction
mode. It consumes calibrated raw IMU and GNSS through the existing estimator. The initial
relative-yaw frame is assumed to point north, as in ADR 5. Absolute heading and physical
navigation remain unobserved. Physical handshake evidence cannot select this mode.

Constant-velocity prediction remains the default. Its velocity lag during braking can appear
as changing wind, and its growing between-fix covariance cannot silently enlarge an accepted
forecast. The original direct-capture prototype remains a planning-limit regression.

The new mode propagates specific force and covariance over qualified capture epochs. Its
held acceleration-error assumption accumulates across the GNSS interval, independently of
how many IMU samples arrive. History, source ages and epoch uncertainty have explicit limits.
Lost IMU data, sparse vectors or retimed fixture epochs withdraw position without a fallback.
A new GNSS initialization changes the position reference; it cannot resume old authority.
The constants and synthetic-heading assumption are retained in navigation evidence.

Planned low-speed braking uses the existing rotor-position tilt range inside the unchanged
attitude/airflow guards. A critically damped landing flare avoids treating a ground velocity
clamp as successful speed control. The flare survives correlated recovery. Original capture,
landing, reserve, fence and independent output-lease limits remain in force.

## Recording and exposure

Capture-time navigation motion is an explicit pose-helper option selected by a validated
bounded-capture mission, independently of its estimator prediction mode. Default pose-only callers retain their original serialized fields, including
inspection, mapping, vision and cinema. Strict recording validators remain unchanged.

Unavailable vehicle navigation is paired null position/velocity with `healthy: false` in a
version-3 vehicle mission trace. Replay blocks deterministically. Existing vector-only
version-2 recordings retain their contract and decisions. The shared workspace shows missing
position as unavailable and omits its current-position marker.

The existing native Buddy command, copied CLI and common stx workspace construct the same
named capture case. Its outcome check binds the actual estimator mode, declared mission and
actual world exposure. Model forecasts do not become received sensors or confirmations.

## Remaining gates

Focused model cases do not establish an interval wind envelope, calibrated uncertainty,
physical initial heading, bias observability, native board execution, HIL or flight acceptance.
Independent review, complete source-matched CI, portable/native output checks and browser
verification accompany publication of this implementation. General wind/recovery
feasibility and measured energy remain separate qualification work under [#12](https://github.com/stacksjs/drone/issues/12).
