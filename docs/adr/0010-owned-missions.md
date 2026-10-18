# ADR 10: Versioned owned mission policy and recorded recovery

Status: accepted for simulation development.

Keep mission graphs and deterministic execution policy in `resources/functions/drone/missions/`.
Use explicit validated observations and output position targets through the existing authority
contract. Keep arm/engage, RC authority, leases, output gating and the independent watchdog outside
the mission policy. Retain ArduPilot/PX4 as optional drivers without importing their protocol into
owned task semantics.

Use strict acyclic v1 graphs to bound execution and event identities. Validate fixed LOCAL_NED,
flat origin terrain, geodetic datum, fence, rally and conservative energy before start. Pause holds
position; abort releases control. Faults latch. Checkpoint recovery recomputes a recorded decision
prefix and requires fresh compatible supervised authority plus explicit operator resume. It never
restores whole-vehicle or physical payload state from a task index.

Exercise this policy through the existing raw-sensor, estimator, multirotor controller, authority
and watchdog fixture. Model the body contact plane 10 cm above origin terrain to represent landing
gear. Preserve the default contact plane for existing control fixtures.

Use native Stacks `defineCommand` for validate/simulate/replay and stx signals/ts-css for the scenario
viewer. No database or background queue belongs in the synchronous mission loop. Private immutable
simulation trace files use bounded regular-file reads, exclusive creation and fsync, following the
local evidence rationale in ADR 9. They are separate from runtime diagnostic journals because they
contain local positions. They are neither authenticated nor crash-prefix recoverable.

The first release does not claim physical execution, terrain following, hardware exactly-once
payload delivery or parity with external autopilot mission systems. The detailed contract,
evidence and remaining gates are in [the mission guide](../missions.md).
