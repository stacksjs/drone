# Retained patrol contact experiment

Issue #24 remains open. The private `createNavigationOccurrenceSession` in
`resources/functions/drone/navigation/runtime.ts` supports two explicitly approved missions
on one simulated vehicle. Optional `contact` accepts `nominal`, `missing`, `wrong-pad`,
`intermittent`, `stale` or `replayed`. Omitting it preserves the existing snapshot shape.
These unsigned local decisions grant no authenticated or physical actuator permission.

The declared switch model uses a central BODY_FRD shoe 0.1 m below the body, transformed
by its actual quaternion. Contact requires the shoe within the inclusive 0.15 m circle
centered at LOCAL_NED `[0.1, 0.06, -0.003]` and within 0.005 m vertically. The source samples
every 20 ms, delivers after 60 ms, declares 1 ms clock uncertainty, and quantizes to one bit.
Its queue holds at most eight packets. Ground contact alone does not identify the selected pad.

The host verifier consumes packets, estimated pose and map, captured interlocks, and
authority/board observations. Body truth is confined to rendering and model evaluation.
Qualification requires current disarmed authority, fault-free neutral board, fresh grounded
and stopped interlocks, a healthy low-motion estimate and the selected map. Alignment uses
`estimated horizontal offset + full map uncertainty + 3 * sqrt(P_NN + P_EE) <= 0.15 m`.
Missing or invalid covariance is unqualified. This allowance is a model assumption,
without calibrated physical confidence.

A successful completed mission opens one 5 second pending window after disarm/revoke.
Distinct positive captures must span 500 ms, with capture gaps at most 40 ms and an age
upper bound at most 100 ms. Repeating a packet cannot accumulate dwell. Missing, open or
unqualified pending observations reset the candidate without extending the deadline.
Binding changes, malformed packets and replay latch failure. The deadline wins at its
exact epoch while pending; historical success does not expire at its former deadline.
Later loss removes current eligibility while preserving that history.

A second launch requires a real current 20 ms host observation both when called and when
actually armed. Refused or denied IDs stay consumed. Queueing does not release contact
monitoring; accepted arm plus engage does, so expected liftoff release cannot fault the
new flight. Blocked missions never open a contact window. Each admitted mission reserves
the unchanged 84 second route budget, its own 5 second contact window and a 2 second tail
within the fixed 180 second experiment. At most two IDs, 512 aggregate pending rows and
64 phase transitions are retained. Verified checks do not grow pending recordings.

Host silence stops all host control, verification and revocation. The source and independent
board/body still advance, while cached host observations and historical outcomes freeze.
Current eligibility becomes unavailable. Invalid clocks never fabricate an independent
board tick or successful recovery.

The nominal modeled flight completed at 44.120 s and verified at 44.860 s. Its acceptance
alignment sum was 0.12096048 m, including the full 0.09 m map allowance. A later settled
observation at 46.120 s had a 0.11418024 m sum, shoe horizontal offset 0.00596502 m and
vertical offset 0.00016229 m. Two retained cycles completed at 44.120 s and 89.120 s,
verified at 44.860 s and 89.860 s, and used 74 pending rows. These are virtual model
observations, not hardware tolerances or physical docking evidence.

Tests exercise actual missing/intermittent full deadlines and neutral motor tails,
wrong-pad identity, genuine stale feedback at call versus arm, regressed original packets,
pending and verified host silence, exact switch edges, and a blocked contact-enabled flight.
Legacy seven-scenario result bytes remain unchanged. The contact-only experiment keeps an
unmeasured nominal hover-load proxy without recharge credit. A separate optional
[partial-charge model](patrol-charge.md) adds explicit permission, instrument verification
and isolation. Measured hardware current, a full weather system, scheduling, persistence,
authenticated patrol review, a patrol workspace, physical docking and recovery remain open.
The [finite patrol command](patrol-cli.md) composes this modeled contact verifier with
explicit unsigned decisions; it adds no physical contact evidence.
