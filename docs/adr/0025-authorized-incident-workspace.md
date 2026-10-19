# ADR 25: authorized incident workspace

Status: design accepted; implementation in progress for issue23.

The first workspace tracer gives an existing native incident member one current
screen for the selected source, explicit observations, append-only reviews and
recipient-confirmed coordination. It adds two server operations: a bounded
coherent snapshot and an authenticated refresh stream. Existing domain commands
remain authoritative. A separate tracer will add actual in-progress execution
of the owned simulator and explicit source admission.

The app currently has no authenticated browser operator shell. This screen owns
a volatile connection form for an existing scoped personal credential. The token
travels only in Authorization headers to fixed same-origin incident paths. It
stays in the current request closure, is cleared from the input after connection
and is discarded on disconnect or identity change. It is excluded from URLs,
SSR hydration, browser persistence and logs. Native session/delegation refusals,
current SQL permission, membership, purpose and retention rules remain intact.

Snapshot staging verifies at most the selected source and a distinct visible
offer's source outside the final transaction. Handle-taking read projectors then
use one native transaction, fresh authority and one common sequence. They check
the complete staged source/configuration and scope again. Public functions that
own independent transactions must not be composed as an allegedly coherent read.
The ordinary selected-source context and an offer's briefing retain independent
source identities and cutoffs. Neither supplies acknowledgement for the other.

Catalog, context and recipient pages use bounded keyset reads. Context cursors
bind the scope, selected source, fixed cutoff and last emitted sequence. They
are pagination data, not authority. Newer selected-source observations and
reviews are counted separately. Notes and reviews preserve original uncertainty.
No raw recording planes appear in the snapshot. A conservative serialized byte
ceiling complements row limits. Verified source imagery uses its existing
separately authorized interface.

The current pointer-matching coordinator can read a bounded recipient list of
active distinct noncoordinator members. It exposes account ID, role and membership
generation, not platform accounts, emails or grant/revocation metadata. Presence
does not assert current recipient platform eligibility; the offer command still
checks that. Other members receive no recipient list or additional handover
participant visibility.

The snapshot declares the actual viewer, a scope/incarnation marker, common
sequence and minimum informational availability deadline. Outer and nested
private projections retain the existing private deadline tags through actual
COMMIT and final HTTP release. Credential and applicable pending-offer expiry
cannot be extended by nesting. A marker or currentness flag grants no authority.
Closed history follows existing policy; mutations remain refused. Accepted purge
freeze and retention expiry deny content.

Native createBroadcastHub/createBroadcastResponse provide single-process HTTP
broadcasting without another listener. They exist in installed .221; importing
them requires a direct runtime dependency, not a framework upgrade or source
bridge. The stream carries fixed content-free refresh hints. Current records
come from fresh authorized reads, rather than broadcast payload copies.

Every delayed authorization captures the complete subscriber async context at
Action entry, before opening a transaction, then explicitly re-enters its native
request context and rechecks current token, SQL grant, membership and scope.
This also prevents a publisher's completed transaction context from leaking
into the delayed SQL read. Installed .221 needs this explicit binding; the
reusable native stream correction is published separately. A broadcaster's
request cannot authorize another subscriber. A thin
release adapter reads native chunks without parsing/rebuilding SSE, rechecks
current authority and synchronously checks expiry before release. Connection,
frame, queue and pending-authorization limits are finite; cancellation releases
native hooks, readers and timers. Released bytes cannot be recalled, and a fresh
SQL decision is not a distributed revocation fence.

Refresh hints register on native transaction completion, including writes whose
response is withheld after a successful commit. Rollback and exact replay do
not announce new writes. Publication failure cannot undo committed SQL. A missed
hint or process loss is repaired by periodic and reconnect reads. No durable
outbox, run table, replay buffer, derivative cache or private filesystem output
is introduced. Existing accepted purge-v1 identities and counts stay unchanged.

The STX screen model owns volatile identity generations, source/cursor selection,
bound form submissions, disconnect/refusal clearing and reconnect resynchronizing.
Old requests and callbacks cannot restore an earlier identity or scope. Conflicts
preserve the human draft but require a fresh binding and explicit resubmission.
Observation/review writes are not blindly retried after an ambiguous response.
Handover uses its existing exact request replay and explicit displayed-context
acknowledgement. Read-only credentials have no mutation controls.

The first tracer claims neither a live vehicle feed nor searched-area coverage.
Plans, capture counts and route positions cannot establish a searched area or
the absence of a person/fire. Source support remains observed synthetic support,
unknown/unobserved or privacy-masked. Human account attribution stays separate
from unsigned producer identity and unqualified physical sensing. No vehicle
lease, pilot qualification, RC authority or physical output is added.

Actual Worker feasibility with the unchanged synchronous simulator supports the
later execution tracer. It still needs native owner authorization, bounded
lifetime/result transfer, actual wire delivery and cancellation qualification.
Sector/team responsibility, scope evolution, geometric coverage and operational,
legal-purpose, firmware and hardware acceptance remain separate work. This
workspace is not completion of issue23.
