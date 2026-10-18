# ADR 6: Separate authority and independent modeled output expiry

Status: accepted first software slice of issue #6. Hardware acceptance remains open.

Implement original version 1 authority under `resources/functions/drone/authority/`, above the
existing estimator/controller. Keep explicit arm and engage transitions, a short issuance-based
command lease, scoped boot/session/epoch/sequence, independent input freshness and latched fault
recovery. A timestamped controller output passes a separate gate before entering modeled actuators.

A separate output watchdog owns its own clock and finite motor-frame lease. Simulated host death
must stop all host code while board ticks continue, proving expiry without a final network command.
Report the stale host snapshot honestly. A new board boot invalidates old commands and requires a
new qualified supervisor session. Zero command is the only implemented degraded action; manual
sticks, landing, rally, parachute and redundant-link behavior remain explicit roadmap requirements.

Reuse the #5 physics/sensor/estimator path through an optional supervised harness. Preserve the
isolated controller baseline. Native Stacks owns command discovery, standalone CLI packaging,
read-only capability reporting and test infrastructure. Do not use asynchronous jobs or a database
as a motor watchdog. Do not connect simulation frames to the neutral-only board runtime or physical
telemetry adapters. The session ID is a fixture scope, not a network security credential.

See [the state/guard/expiry contract and remaining hardware gates](../authority.md) and
[the reproducible software report](../authority-evidence.json). No measured HIL, physical flight,
kill circuitry, native control port or airborne recovery guarantee follows from these results.
