# ADR 11: Separate owned perception, navigation and authority

Status: accepted for simulation development.

Keep raw synthetic range production, calibrated detector outputs, geometric planning and policy
in separate modules under `resources/functions/drone/navigation/`. Consume estimator capture-time
poses; use truth only in the renderer and independent evaluation. Keep metric target selection
explicit, bind map/target identities to the owned reference, and reject stale or partial coverage.

Use a bounded visibility graph around inflated columns, with reaction, braking, uncertainty and
tracking allowances. A local observed plane supports explicit terrain-clearance guidance. Selected
range landing targets require site, slope, uncertainty and planned-position agreement. The owned
mission engine retains task acceptance while the authority supervisor and independent modeled
watchdog retain actuator permission and expiry.

All hardware profiles remain receive-only or neutral-only. The first profile is a synthetic full
coverage range model with cylindrical columns and shallow planar ground. Its latency is measured
on a virtual clock; controller dynamics, uncertainty and physical sensor behavior need separate
acceptance. Abort/revocation zeros modeled thrust and is not a physical landing policy.

Use native Stacks command discovery for `navigation:simulate` and the existing standalone CLI build.
Do not add queues, persistence or network endpoints inside the synchronous navigation/control loop.
Detailed equations, evidence, limitations and remaining issue #11 gates are in [navigation](../navigation.md).
