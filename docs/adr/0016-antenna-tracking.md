# ADR 16: Owned bounded antenna tracking

Status: accepted for software simulation; physical bench acceptance pending.

Issue #16 needs an antenna pointed at one explicitly selected vehicle without giving telemetry
authority to choose a different target or to resume motion after a fault. Keep the policy in owned
TypeScript functions and expose a native Stacks `defineCommand` bench. Reuse the owned estimator's
WGS84 ECEF-to-fixed-NED transform and expose ENU as east, north, negative down. External firmware
is an optional telemetry source, not a dependency of this controller.

Surveyed origin and level-mount true north/elevation calibration are mandatory inputs. The planner
unwraps the shortest continuous pan solution against its current modeled mechanical position.
If that solution exceeds mechanical travel or cable twist, stop. Do not silently take a long unwind
path. Slew rate and acceleration bound normal trajectories; stop and emergency directives request
an immediate software hold and make no claim about physical stopping acceleration or distance.

Telemetry must already have authenticated identity, a source boot/session, an increasing sequence,
and capture epochs mapped to the controller's one local monotonic clock. Gate both measurement age
and local receipt age. Preserve a bounded replay ledger across selection changes. Stop for selected
source reboot, replay, clock reversal, uncertainty, stale fixes/link observations and poor link
quality. Fault recovery, manual override and emergency reset require explicit operator operations.
Manual motion has a short renewable lease and never resumes target tracking automatically.

The deterministic bench synthesizes geodetic measurements by an inverse ECEF calculation while
scoring against the original moving local vector. Its mount lag and RF pattern are declared models.
Report modeled pointing error and modeled signal correlation separately from measured hardware
evidence. No PWM, GPIO, serial, UDP, payload actuator or physical endpoint is added.

Physical acceptance still needs a surveyed mount, encoder calibration, independent braking/stop
authority, travel and cable tests, transport/clock qualification and timestamped measured pointing
and RF observations. Keep issue #16 open for those gates. Software tests do not satisfy the issue's
physical bench criterion. See [the implementation and bench contract](../antenna.md).
