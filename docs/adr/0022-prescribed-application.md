# ADR 22: Separate implement authority and measured application evidence

Status: accepted for owned simulation development.

Implement prescribed inert-water and inert-granule application on the existing owned ground
sensor/estimator/mission/authority/watchdog runtime. Keep domain policy under
`resources/functions/drone/application/`, native Stacks commands in `app/Commands/` and a stx
evidence workspace. Keep external autopilot drivers optional. Do not add a parallel task scheduler,
database or background queue to the synchronous metering loop.

Preserve the four ground channels and add independently modeled primary, master and energy
channels. Evolve material and barrier physics before rendering delayed quantized instruments.
Use estimated navigation plus measured pulses/scale/encoders for the host policy; retain plant
truth only as explicitly independent simulation evidence. Scope a separate monotonic implement
lease to visit/configuration/material/reference. Default to dry test with no grant. Require both
apply mode and a grant for modeled discharge. Never infer physical authorization from simulation.

Reject unsupported units/geometry/calibration, bound work, forecast the full uncertain footprint,
and retain fault latches. A command to close must be checked against modeled barrier/flow state.
Evolve a bounded independent neutral tail without inventing host data after host loss. A double
mechanical failure must remain unverified rather than forcing a successful shutdown result.

Audit actual finite release stamps through an explicitly declared uniform deposition model and
exact polygon unions/clipping. Preserve excluded/outside/in-flight quantity, missed support and
distinct-pass overlap. Keep target, measured ledger and independent modeled material truth separate.
Source replay verifies consistency without authenticating a producer or claiming whole-runtime recovery.

Reuse the shared completed-artifact publication helper and async CLI output already contributed to
Stacks. Keep filesystem exports outside browser barrels. Physical hardware calibration, distribution,
isolation, weather/drift, local requirements, board transport and HIL acceptance stay explicit and open.
The detailed semantics and limits are in [the application guide](https://github.com/stacksjs/drone/blob/main/docs/application.md).
