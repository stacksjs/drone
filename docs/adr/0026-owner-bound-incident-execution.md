# ADR 26: owner-bound incident execution

Status: accepted; source application tracer implemented for issue #23. Native
controller, HTTP and rendered-browser checks gate publication.

The next workspace tracer runs the existing owned synthetic public-safety
simulator, displays genuine producer progress and retains a bounded completed
recording for deliberate source admission. The complete human path includes
start, progress, stop, completion and explicit admission. It builds on the
authorized read/command workspace in ADR 25.

Five operations serve this caller: POST start, GET current status, GET progress,
POST close and POST source admission. Start captures an explicit client intent,
current workspace scope, scenario and requested virtual duration. Status helps
reconcile an ambiguous start response. GET progress only attaches to existing
work. Native STX stream reconnects cannot start or rerun a simulation. Close
stops unfinished work or discards completed bytes. Admission separately uses
the existing source-registration writer.

Execution IDs, intent IDs and scope markers are locators and preconditions.
Every operation independently checks native authority. Credentials remain in
volatile Authorization headers. Process loss or expiry loses execution state;
a missing current slot cannot prove that an earlier intent never ran. Duplicate
start conflicts while the current reservation is retained. The caller never
blindly retries an ambiguous start or admission.

The initial controller admits one global active, completed or quarantined
reservation. It owns at most one uncredited producer event and one subscriber.
The original account, personal token, member ID/version/role, incident
incarnation, full persisted configuration and process scope bind the work.
Another token for the same account cannot adopt it. Ordinary incident sequence
changes alone do not replace its configuration or scope. Current read and
coordinate scopes, source-register permission, Gates, platform SQL grants,
active incident state and retention policy remain authoritative throughout.

Capture the complete initiating async context at Action entry before opening a
transaction. Capture each subscriber independently. Every delayed owner check
re-enters the original context and opens a fresh native transaction. No
transaction waits for a Worker or stream. Checks precede producer credits,
content release, result acceptance and admission. Subscriber authorization
never inherits the publisher's request or completed transaction.

An actual Bun Worker runs the unchanged synchronous producer. Its only domain
input is explicit cloned synthetic configuration, scenario and duration. Empty
environment and preload options isolate application bootstrap state in the
supported runtime. The Worker uses a private synchronization buffer to wait
after each genuine onEvent callback. Synchronization and recording planes never
enter public progress DTOs. The worker entrypoint follows the native app build;
its Action-owned URL must work from both source and emitted artifacts.

Parent cancellation immediately ends eligibility for future credits, content,
completion and admission. The producer cooperatively checks cancellation at
its real callback boundaries. A final owned-code acknowledgement establishes
that producer, serialization and transfer work have finished. The Worker accepts
one start message, clears its handler and drains naturally after that
acknowledgement. Bun Worker close is a marked termination event and does not
establish OS thread exit. An unconfirmed forced stop quarantines the scarce
reservation until qualified
resolution or process replacement. A timer or close marker cannot release it.
The contract provides finite logical admission and fail-closed publication;
hard CPU/RSS bounds, instruction-level interruption and immediate reclamation
require separate runtime evidence.

Finite wall, attach/reconnect, authorization, stream, stop and completed-result
deadlines are capped by original token and incident retention deadlines. Final
canonical recording bytes retain the existing 16 MiB ceiling. An unsupported or
oversized result is refused without truncation. Full byte/digest validation,
canonical replay and current authority precede result acceptance. A late result
cannot restore canceled, expired or discarded work. Numeric defaults are set
from actual native measurements and tested at the controller/HTTP boundaries.

The initial settings in `config/execution.ts` are one reservation, one
subscriber, eight pending checks, two native pending frames and 4,096 bytes per
frame. Authorization and heartbeat intervals are two seconds; stream renewal is
30 seconds. Consumer attach/reconnect grace is ten seconds, private credit wait
20 seconds, wall lifetime 60 seconds, cooperative-stop grace two seconds and
terminal retention 60 seconds. These finite policy choices have explicit refusal
behavior and require actual controller/HTTP qualification. They are not hard
scheduling or resource guarantees.

An isolated Worker probe transferred full recordings for all ten existing
scenarios at requested durations 100 and 120 seconds. The production controller
subsequently passed all 20 combinations through actual native authority,
14,384 genuine callback credits and explicit source admission. Each complete
recording matched the unchanged ordinary runtime's canonical bytes. Completion
alone changed no source, incident version or audit; deliberate admission added
one source and one audit and advanced the version once. The nine fault scenarios
demonstrated blocked or aborted collection with neutral board outputs.

The matrix took 149 seconds on the development host. Its fixtures compute the
ordinary expectation before starting the controller, warming parent modules and
retaining an additional canonical string. Nominal controller completion took
approximately 15.69 and 14.49 seconds; parent canonical replay took 2.27 and
2.45 seconds. All 33 sampled periodic subscriber checks succeeded. Every result
entered replay with no pending check or busy owner heartbeat. Validation remains
intact, with current authority and deadline checks after it returns.

Separate native fixtures qualified three controlled pending-check overlaps.
An original-owner heartbeat held across 2.68 seconds of genuine result replay
refused completion. A subscriber check held across 2.53 seconds of replay
returned 404 and released only that observer; the original owner completed and
deliberately admitted the recording. During admission, a subscriber check
crossed its budget across a 5.39-second source-work/task interval. Its actual
SQL transaction settled before the serialized source writer committed once.
That last interval includes validation, encoding, hashing, promise scheduling
and writer-queue initiation; it is not an isolated CPU measurement. These are
controlled native Gate and genuine-message scheduling fixtures, without clock
or policy-budget changes. They do not qualify Pi hardware or bound worst-case
scheduling, CPU or memory use.

Native createBroadcastHub/createBroadcastResponse own progress framing and
bounded pending delivery. The stream rejects replay-buffer matches and uses
the existing opaque-chunk release pattern with fresh current authority. A
native enqueue is not evidence of remote receipt. The before-return claim is
qualified by an actual HTTP and rendered STX observer receiving a real producer
event while a later private credit is held and the simulator has not returned.
There is no public per-event acknowledgement or finished-array progress replay.

Producer credit must follow successful native enqueue of that exact progress
view. Calling `emit` alone cannot establish enqueue: native authorization runs
later and may close a full stream. Connected and heartbeat frames cannot grant
an application credit. Native closure releases the execution subscriber and
rejects any pending publication. The outer reader still checks current authority
before releasing unchanged native bytes.

The installed realtime package, 0.75.221, lacks enqueue and close observers.
Contribute those optional observers to Stacks, then pin the reviewed stream
implementation in a narrow application compatibility module using the installed
native hub. This bridge requires its own source and copied-artifact tests and
does not upgrade the installed package. Remove it when an adopted native release
passes the same enqueue, closure and subscriber-context tests. No alternate event
bus, frame parser, wire reconstruction or package publication is part of this
decision.

Completion writes no durable source. Explicit admission single-flights against
close and uses one private checked-registration seam in the existing sole
writer. After canonical replay, that seam checks original owner, membership
generation, incarnation, scope, full configuration and result deadline on the
actual mutation transaction before advance, insert or audit. Existing public
registration fields and coordinate-only callers remain compatible. Existing
CAS, uploader attribution, audit, afterCommit refresh and deadline semantics
remain intact. A close cannot promise to undo a submitting or committed write.
A committed write whose response was withheld has an ambiguous caller outcome;
a fresh authorized catalog/digest read reconciles durable existence without
claiming which racing request inserted it.

The small STX panel keeps scenario and declaration drafts local. Start and
admission bind intent, execution, scope and identity generation. Old responses
cannot erase newer drafts, switch selected imagery, acknowledge a handover or
restore another identity's content. Progress shows requested duration separately
from actual virtual time, survey status and demonstrated faults. Synthetic
counts and routes establish neither searched area nor absence of people/fire.

Qualification requires genuine native Auth/Gates/SQLite and original-token,
membership ABA, incarnation, configuration, retention and commit races; actual
controller cancellation, malformed/oversized/late protocols and quarantined
capacity; positive native-parent preload and negative Worker bootstrap checks;
real Action source/artifact entrypoint resolution; and native HTTP/rendered STX
progress, stop, completion and explicit admission. Required Linux CI and the
existing source/workspace/retention/purge regressions gate publication.

The first deployment target is the source Stacks application with a file-based
Worker. An Action-owned Worker URL has separate source and emitted-file evidence.
Complete authenticated bundled server and Docker support need their own
qualification, including generated registry paths and shared native Gate state.
A benign Worker artifact test does not establish those deployment properties.

The process-local tracer adds no run model, durable queue, filesystem output,
derivative cache or accepted purge-v1 inventory item. Released bytes cannot be
recalled. Sector/team assignments, searched-area geometry, operational/legal
acceptance, firmware and hardware support remain separate issue #23 work.
