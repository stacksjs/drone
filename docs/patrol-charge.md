# Explicit partial-charge experiment

The private `createNavigationOccurrenceSession` in
`resources/functions/drone/navigation/runtime.ts` accepts an optional `charge` profile when
`contact` is also selected. Profiles are `nominal`, `no-current`, `current-stuck`,
`stuck-relay`, `feedback-loss`, `feedback-replay` and `mains-loss`. Issue #24 remains open
for recurrence, authenticated patrol review/audit, persistence, recovery, a full weather
system and physical qualification. This experiment has no charger hardware transport.

Only the charge-enabled adapter exposes `requestCharge()` and `stopCharge()`. A request is
an unsigned local decision with exactly `{ id, occurrenceId, issuedAtMs, decision }`, where
decision is `approve` or `deny`. The boundary copies own data primitives before reading
current runtime time, host availability and queued flight reservations. Accessors and
malformed inspection end host eligibility without a fabricated final revoke. IDs stay
consumed after denial or refusal. Contact alone never starts charging.

Approval binds the current occurrence and historical contact verification identity,
vehicle, pad, model, session, boots and estimator reference. Fresh qualification is checked
at the actual call and next host start tick. Flight authority must be disarmed with a
fault-free neutral board, captured grounded/stopped interlocks, qualified estimate and
current selected-pad contact. A flight queued first refuses a later charge request.
Queued or active charging consumes and refuses a new flight intent without waiting for
later isolation. Busy charge requests cannot replace or stop an active episode.

The independent charge adapter reuses the existing output-watchdog kernel with one neutral
channel, charger boot 77, session 123 and a 60 ms lease. It runs on the retained 4 ms model
clock before the host guard. At time t it expires permission first, integrates the completed
interval with the prior physical response, cancels superseded relay transitions, applies
remaining due events for future intervals, then captures/delivers instruments. A relay
closing at t cannot add energy to the preceding interval. A host command is first observed
by the independent plant at the following tick. Repeated renewals do not reset relay delay.

The declared synthetic pack starts at 20 Wh. Battery terminal voltage is constant 14.8 V,
branch current targets 2 A, and terminal-to-stored efficiency is 0.90. Relay delay is 40 ms;
current and the defined 16 V charger-side node use a 20 ms exponential response. True stored
gain integrates `0.90 * 14.8 * branch current` over actual intervals, with capacity clipping
and the existing nominal powered-load subtraction. `usedWh` and original capacity never
reset. These values are simulation assumptions without physical battery or charger ratings.

Independent instruments sample every 20 ms, deliver after 40 ms and declare 1 ms clock
uncertainty. Voltage/current quantization is 0.01 V/A; pack energy quantization is 0.001 Wh.
The model reports mains, pack/charger temperature and enclosure/precipitation observations.
Qualification requires the declared quantized 14.8 V model, mains, dry conditions, no
precipitation, pack temperature 5..40 C and charger temperature 5..50 C. Mains loss is an
integrated fault scenario; other unsafe environment values have pure qualification tests.
A dynamic weather or thermal model remains future work.

Host energy accounting uses fresh distinct samples from one uninterrupted eligible-on
segment, beginning at the first qualified current of at least 1.5 A. The voltage/current
lower integral includes efficiency, half-quantum allowances and reduced elapsed time.
Its upper envelope uses the declared 2.005 A bound and expanded elapsed time. The same
capture endpoints bound independent pack-energy gain with a 0.001 Wh delta allowance.
Verification needs 1000 ms of distinct positive captures and a pack-gain lower bound above
0.004 Wh, consistent with the integrals. A stuck-high current sensor cannot verify against
a flat pack-energy instrument. Startup, stop, fault, host-absence and cross-episode intervals
receive no backfilled credit.

Only conservative verified credit enters the policy:
`remainingWh = clamp(20 - usedWh + verifiedCreditWh, 0, 20)`.
Supervisor, mission and launch reserve use this ledger. True pack energy remains renderer
and evaluator evidence. Snapshots expose true gain, measured bounds and policy credit
separately. A stuck relay may continue adding actual modeled energy after permission ends;
the host cannot turn that unverified gain into launch permission.

Startup needs fresh post-off isolation samples spanning 200 ms before its fixed 1 second
deadline. An accepted charge episode lasts at most 8 seconds and must verify within
3 seconds. Stop immediately revokes renewal and starts one fixed 1 second isolation window.
Only captures strictly after both requested and independently observed off can contribute.
Isolation needs open relay, absolute branch current at most 0.02 A, charger-side node at most
0.2 V, valid battery voltage and 200 ms of distinct fresh observations. Battery voltage
remains 14.8 V when isolated. Repeating stop cannot extend the window or clear a latch.
Electrical isolation can be established after a contact or mains fault while launch remains
blocked by recovery and current readiness checks.

The experiment keeps the existing 180 second horizon, at most two charge IDs and two flight
IDs, 512 aggregate pending rows and 64 transitions. Each charge admission reserves the full
8 second episode, 1 second isolation window and 2 second tail, including the next start tick.
Each flight keeps its full 84 second route, 5 second contact window and 2 second tail.
Host silence freezes all host observations, credit, counters and episode history while the
independent watchdog, relay, current, pack and source continue. No successful recovery is exposed.

In the nominal model, startup isolation verified at 0.660 s. The first mission completed
at 44.120 s and contact verified at 44.860 s. Explicit charge started at 47.020 s, relay
closed at 47.064 s with zero preceding gain, and charge verified at 48.160 s. The 8 second
limit requested off at 55.020 s, the independent plant observed off at 55.024 s, and fresh
feedback proved isolation at 55.400 s before the 56.020 s deadline. Actual stored gain
including its tail was 0.0592 Wh, matching the independent 2 A by 8 second pulse integral.
Conservative credit was 0.05205362 Wh. A separately approved flight started at 56.040 s
and completed on the retained world.

Tests also retain two charge episodes with immutable first history, genuine host silence
and lease expiry, zero current, falsely positive current, a stuck relay, lost/replayed
feedback, mains/contact loss, input inspection reentrancy, both flight/charge request
orders, finite capacity and exact refusal behavior. Seven full legacy navigation results
remain byte-identical. Physical charging, unattended operation, HIL and endurance evidence
are outside this modeled checkpoint.
