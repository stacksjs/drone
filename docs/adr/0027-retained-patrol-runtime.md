# ADR 27: Retain the simulated vehicle between patrol decisions

Status: accepted for simulation development, issue #24 remains open.

Patrols need an owned vehicle lifetime beyond one scripted mission. Keep the rigid body,
raw sensor feed, estimator, controller, authority supervisor, independent output watchdog,
absolute clock and nominal energy ledger together. A mission ending must not reset the
vehicle, stop motor lag or fabricate a fresh sensor reference.

The first private `createNavigationSession` experiment admits one explicit start attempt,
including a refused attempt. It waits without arming, evaluates the request against fresh
grounded/stopped interlocks, and freezes the first terminal mission trace while continuing
the actual board, body and host sensor tail. The bounded experiment lasts at most 120 seconds
on a 4 ms virtual clock. A start must leave the validated worst-case mission time plus a
2 second terminal tail. Existing public seven-scenario navigation fixtures retain their
original scripted start, limits and exact result projections.

Host silence stops all host updates, commands and revocation. Only the independent modeled
board can expire the retained actuator frame; the body continues responding to motor lag
and gravity. Host snapshots remain explicitly stale. Invalid clock input ends host launch
eligibility without advancing the board with that invalid time. A later valid advance can
still demonstrate board expiry. This experiment exposes no successful host recovery.

Energy is a nominal hover-load proxy while modeled thrust or motor lag is present. It is
not measured battery current, idle consumption, charging or an endurance qualification.
Keep mission traces separate from current vehicle state so terminal evidence cannot be
mistaken for live telemetry.

A separate private `createNavigationOccurrenceSession` experiment supports at most two
manual approve/deny identities in 180 seconds. Each approval binds the current qualified
plan, session, boot and estimator reference at request and arm time. Refused attempts stay
consumed; an overlapping request cannot replace or disarm the active mission. Repetition
requires a completed mission and fresh grounded/stopped checks. Only the mission engine,
navigator and per-flight recording restart. The retained controller keeps its normal
20 ms disabled cadence between flights, and energy and sensor/actuator sequences continue.
Each request must leave the unchanged 84 second worst-case mission budget and 2 second tail.
These unsigned fixture decisions do not establish authenticated operator permission.

An optional closed contact profile adds a selected-pad switch renderer and post-completion
verifier within the same two-occurrence lifetime. The renderer alone consumes body truth.
The host requires fresh disarmed/neutral authority, captured grounded/stopped interlocks,
estimated alignment including full map and covariance uncertainty, and distinct positive
samples spanning 500 ms. The 5 second pending window starts only after completion and
disarm/revoke. Verified history remains separate from continuously checked eligibility.
Only accepted arm plus engage retires the prior live window. Host absence freezes host
verification while source and independent board/body continue. Each contact-enabled
request additionally reserves the full 5 second window; the 180 second ceiling stays fixed.
See [the declared model and evidence](../patrol-contact.md). This is simulated contact,
without charge permission, energy credit or physical validation.

An optional closed partial-charge profile now adds explicit one-use charge approval,
a private one-channel adapter over the unchanged watchdog kernel, and independently
evolving relay/current/pack instruments. Charging requires disarmed flight authority
and current qualified contact. Positive current and independently consistent stored
energy must verify before conservative credit enters the policy ledger. Stop retires
permission immediately; later fresh measurements must prove electrical isolation.
Electrical isolation remains distinct from contact/environment readiness and latched
recovery. A queued flight blocks charge, and queued or active charge blocks a new flight.
Normalize unknown input before reading current owned time, availability and reservations.
Keep prior completed episodes immutable when canceling a later queued approval.
See [the fixed model, causal order and evidence](../patrol-charge.md).

Build recurrence in subsequent bounded steps.
Scheduling must never grant actuator authority or silently retry a refused launch.
Native Stacks commands and application services belong outside the synchronous control
loop. Durable review/audit, weather interlocks, failed docking and recovery, HIL and
physical trials remain open.
