# ADR 24: recipient-confirmed incident coordination

Status: design accepted; implementation and qualification in progress for issue23.

An assignment is responsibility for coordinating the whole incident. Its identity
includes the incident revision, coordinator account and that coordinator's active
membership version. It does not grant a vehicle lease, pilot qualification, RC
authority, physical output or a sector assignment.

An outgoing coordinator offers this responsibility to one existing active human
member. The offer binds both membership versions, an immutable selected source,
the incident configuration, an explicit outgoing role, a context cutoff and a
short expiry. The recipient reads a bounded briefing and explicitly acknowledges
its source, cutoff and uncertainty when accepting. This records a human assertion;
it does not prove that a person read or understood every record.

The module exposes desk, offer and decision operations. Native Actions, Gates,
scoped personal credentials and cache-free SQL permissions remain the authority
path. Acceptance updates both membership roles and versions, the coordinator
pointer, the common incident sequence and one terminal audit in a single native
transaction. Cancellation and decline append a terminal decision without moving
responsibility. Competing decisions have one winner.

Unrelated observations can continue during handover. The current locked incident
version supplies the internal compare-and-swap and audit sequence. Assignment
and membership generations supply the semantic preconditions, so ordinary new
observations do not invalidate the offer. Membership revocation followed by a
regrant, or a coordinator returning after another transfer, cannot revive an old
offer. Platform eligibility is checked currently; no global permission-revocation
epoch is claimed.

The selected-source briefing merges actual observations and reviews through the
fixed offered sequence. Reviews preserve the original observation's uncertainty.
Later records are reported separately and are not described as acknowledged.
This is an incident-wide assignment with one selected-source snapshot, rather
than a complete operational picture or a live vehicle feed.

Offers and terminal decisions are immutable protocol rows in PublicSafetyAudit.
Nullable lookup fields and native unique indexes support bounded request replay
and one terminal decision. This makes the audit an authoritative domain protocol,
so its versioned parser and append-only behavior are part of the contract.
Historical receipts are distinguished from current responsibility. Identical
requests reauthorize the current actor before replay; they never repeat the
transfer or restore lost access.

Using the existing audit ledger keeps all handover payload within the accepted
purge-v1 audit group. Fixed inventory fields, digests and accepted counts remain
unchanged, and whole-row removal erases the new lookup and context fields. The
native generated SQLite audit rebuild must preserve historical IDs and facts,
indexes and foreign-key integrity. No private handover tombstone is copied into
surviving custody or purge metadata.

New command responses retain the minimum offer and incident deadline through
actual commit and final HTTP delivery. Later authorized historical terminal
reads may remain available through incident retention without an actionable
briefing. A withheld post-commit response does not reverse a committed transfer.

Dedicated assignment, offer and receipt models were considered. They would make
future sector and team lifecycles more explicit, but require separately accepted
purge coverage and backward handling for already frozen v1 plans. Introduce those
models when that lifecycle is implemented, with an explicit protocol evolution.
Do not grow this narrow audit protocol into a generic workflow engine.

The authorized live workspace, sector assignments, real operational procedures
and hardware qualification remain separate work. Reversal uses another fresh
two-phase handover. Rollback must preserve committed roles, pointer and audit
history together. Existing unsigned simulation and physical-unqualified flags
remain unchanged.
