# ADR 26: owner-bound incident execution

Status: design accepted; implementation in progress for issue #23. Routes and
browser controls require the execution qualification described below.

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
that producer, serialization and transfer work have finished. Bun Worker close
is a marked termination event and does not establish OS thread exit. An
unconfirmed forced stop quarantines the scarce reservation until qualified
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

Native createBroadcastHub/createBroadcastResponse own progress framing and
bounded pending delivery. The stream rejects replay-buffer matches and uses
the existing opaque-chunk release pattern with fresh current authority. A
native enqueue is not evidence of remote receipt. The before-return claim is
qualified by an actual HTTP and rendered STX observer receiving a real producer
event while a later private credit is held and the simulator has not returned.
There is no public per-event acknowledgement or finished-array progress replay.

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

Qualification covers genuine native Auth/Gates/SQLite and original-token,
membership ABA, incarnation, configuration, retention and commit races; actual
controller cancellation, malformed/oversized/late protocols and quarantined
capacity; positive native-parent preload and negative Worker bootstrap checks;
real Action source/artifact entrypoint resolution; and native HTTP/rendered STX
progress, stop, completion and explicit admission. Required Linux CI and the
existing source/workspace/retention/purge regressions gate publication.

The process-local tracer adds no run model, durable queue, filesystem output,
derivative cache or accepted purge-v1 inventory item. Released bytes cannot be
recalled. Sector/team assignments, searched-area geometry, operational/legal
acceptance, firmware and hardware support remain separate issue #23 work.
