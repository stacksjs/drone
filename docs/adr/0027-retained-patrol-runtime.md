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

Build repeated occurrences, dock/contact/charge verification and recurrence in subsequent
bounded steps. Each occurrence needs separate explicit permission; scheduling must never
grant actuator authority or silently retry a refused launch. Native Stacks commands and
application services belong outside the synchronous control loop. Durable review/audit,
weather interlocks, failed docking and recovery, HIL and physical trials remain open.
