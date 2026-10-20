# Finite patrol recurrence and explicit review

The private patrol experiment uses `@stacksjs/cron` to select two UTC minute slots.
It creates no timer or scheduler registration. `createPatrolRecurrence` in
`resources/functions/drone/navigation/recurrence.ts` owns one immutable schedule identity
and revision. Its closed `minute-zero-one-v1` profile selects the anchor minute and the
following minute. The third native result is an excluded boundary sentinel.

A scan creates at most two review records. A slot within its five-second review window
may await an explicit local decision. Busy, late and denied slots stay consumed. Another
healthy scan cannot retry them. An approved review emits a handoff description only on
that call. Snapshots and duplicate reviews cannot emit another handoff. This is unsigned
private simulation metadata, without authenticated identity or durable replay protection.
The runtime separately consumes and qualifies its own flight request. Charge approval
remains a separate explicit decision.

UTC and monotonic time have one fixed mapping anchored at construction. The review
deadline is original due time plus 5000 ms, exclusive at the deadline. A slot older than
30000 ms is missed. Successful scans must be at most 60000 ms apart, starting at the
anchor. Review calls do not refresh that gap baseline. A rewind, mismatched clock or
longer scan gap blocks further approvals without rewriting completed decision history.
No clock recovery or catch-up launch is exposed.

Inputs require exact own plain data fields. Values are copied before reading ledger
state. Before a latch, malformed inspection throws without changing published history or clocks.
A latched handle returns bounded results without inspecting later input.
Reentrant calls abort the outer operation even if a caller catches the nested error.
There are no caller callbacks or mutable parser/vehicle collaborators. Native parse
handles matching with an explicit exclusive cursor and UTC. Unsupported profiles and
invalid Date arithmetic are rejected before parsing.

The limits are a 180 second monotonic horizon, three native parser calls, two selected
records, two recorded review identities, eight transition entries and one compact fatal
summary. Summaries count only known selected slots. They do not invent missed counts
outside that selection. Each handle is one live owner scope; separate handles provide
no shared uniqueness or durable exactly-once effect.

The nominal integration test composes the actual ledger with one retained navigation
session. Due alone leaves flight and charge neutral. An explicit first review at 2.000 s
leads to a start at 2.020 s and completion at 44.120 s. Contact then qualifies. A separate
charge approval at 47.000 s produces measured modeled isolation at 55.400 s. The native
second slot at 60.000 s awaits another explicit review; its flight starts at 60.020 s and
completes at 102.120 s, followed by verified contact. Sensor and output sequences advance
while first mission/contact history, reference, session and boot identities remain intact.

Actual modeled stored gain is 0.0592 Wh, with conservative verified credit of
0.05205362 Wh. Cumulative nominal powered load is 4.704 Wh; policy remaining energy is
15.34805362 Wh. These are synthetic model results, without idle-load or endurance
measurement. See [contact](patrol-contact.md) and [partial charging](patrol-charge.md)
for their fixed models and limits.

The runtime's independent admission still requires its full 84 second route, 5 second
contact window and 2 second tail. The second start budget fits the unchanged horizon:
60000 + 20 + 84000 + 5000 + 2000 = 151020 ms, below 180000 ms. A positive local review
followed by runtime refusal stays consumed, without a retry or restored approval.

Issue #24 remains open for production scheduling, authenticated patrol permissions and
audit, persistence/concurrency/restart outcomes, a patrol workspace, weather,
recovery and physical qualification. This ledger does not qualify unattended docking,
charging or field operation.

The [finite patrol command](patrol-cli.md) now composes this ledger and retained model
with explicit unsigned decision files. Its neutral default never supplies a review or charge
approval. The command does not register a scheduler or add production launch permission.
