# ADR 12: share policy lifecycle across owned vehicle profiles

Status: accepted for modeled physics execution, October 18, 2026.

Fixed-wing, ground and surface vehicles need different dynamics, measurements, controls and neutral
actuator values. They share mission graph validation, runtime sensor/estimator ownership, authority
leases, replay and operator visibility. Separate kinematic demos would not exercise those boundaries.

Use explicit v2 vehicle missions and per-execution sessions behind a small profile contract. Extract
the existing authority lifecycle and board lease mechanism into typed kernels while retaining the
v1 quadcopter wrappers and limits. Controller input remains owned estimated state plus qualified
vehicle measurements. Plant truth is evaluation evidence only. Scoped modeled payload ports share
mission semantics without claiming physical device delivery. Native Stacks commands and stx views
wrap the same public functions; native storage writes optional modeled survey artifacts.

Required session factories keep sensor sequences, implement state, containers and closed-port state
isolated across repeated runs. This contract is for the new modeled profiles; it does not introduce
a transport registry or require external firmware. Unsupported vehicle families remain in the roadmap.
No hardware output capability is added. Physical acceptance and board porting need separate evidence.
