# Incident coordination handover

Implementation qualification is in progress on the handover branch. This is a
recipient-confirmed transfer of responsibility for coordinating one whole
incident. Vehicle control, RC authority, runtime leases, pilot qualification,
sector assignments and physical outputs remain separate.

The outgoing operator must be both the current coordinator pointer and an active
coordinator member. The recipient must already be a distinct active member with
a noncoordinator role and native platform eligibility. Both use their own current
personal Stacks credentials. Delegated and session-only credentials do not
satisfy this interface. Reads require public-safety:read; commands require
public-safety:coordinate. A coordinate credential does not need a second read
scope merely to perform an otherwise authorized command.

## Native HTTP interface

All paths begin with /api/public-safety/incidents/{incident}. Auth, native Gates,
current platform permissions and actual incident membership apply. Mutation
bodies are limited to 8192 streamed bytes after the authorization preflight.
Strict JSON refuses duplicate object keys, including escaped spellings. Unknown
fields, repeated query parameters and noncanonical identifiers are rejected.
Cookie credentials require native CSRF protection. Successful and failed
responses are private and no-store.

| Method | Path | Result |
| --- | --- | --- |
| GET | /handover | Current assignment, visible offer, briefing and actionability. |
| POST | /handover/offer | New offer 201; exact authorized retry 200. |
| POST | /handover/decision | Accepted, declined or canceled receipt 200. |

GET accepts optional single offer, after and limit parameters. offer is a
canonical lowercase UUIDv4 selecting a historical offer. after is the last emitted
common incident sequence, starting at 0; limit is 1..100, default 100. Returned
cursor and hasMore support keyset traversal. An unrelated active member can read
the current assignment and their own incident projection, without enumerating
another person's offers. Full offer access is limited to the current authorized
participants, coordinator and evidence custodian.

Errors use the existing private incident envelope: 401 for credentials, 403 for
current permission, 404 for unavailable content, 409 for conflicting state,
413 for body size, 415 for media type and 422 for invalid fields. Invalid JSON
is 400. Internal database details are excluded.

The desk returns assignment, incident, offer, briefing and actionability. The
actionability flags describe current permission, not a transferable capability.
The server rechecks it during every command. A historical selected offer cannot
make canOffer true while another valid current offer is pending.

## Offer and acknowledge

Read the desk for the current assignment. Offer one explicit outgoing role and
one immutable selected source:

```json
{
  "requestId": "80000000-0000-4000-8000-000000000001",
  "assignment": {
    "kind": "incident-coordination",
    "coordinatorId": 1,
    "coordinatorMembershipVersion": 1
  },
  "recipientUserId": 2,
  "recipientMembershipVersion": 1,
  "sourceDigest": "<the selected source's actual 64-character lowercase digest>",
  "outgoingRole": "observer",
  "expiresInSeconds": 300
}
```

Use the actual account IDs, membership versions, assignment and source digest.
outgoingRole is pilot, observer, reviewer or evidence-custodian. The offer lifetime
is 30..1800 whole seconds, capped by incident retention. Its expiry is calculated
once and retained across exact retries. A valid current pending offer blocks a
second offer for the same assignment generation.

The recipient uses their own credential to read the returned offer key and its
briefing. Acceptance includes the server-provided acknowledgementRequired object:

```json
{
  "requestId": "80000000-0000-4000-8000-000000000002",
  "offerKey": "<the returned offer key>",
  "decision": "accept",
  "acknowledgement": {
    "offerDigest": "<the returned offer digest>",
    "assignment": "incident-coordination",
    "sourceDigest": "<the returned source digest>",
    "contextThroughSequence": 7,
    "uncertaintyAcknowledged": true
  }
}
```

Copy the actual cutoff and digest values. This records the accepting person's
assertion about that specific context; the server does not prove comprehension.
An offer ID or acknowledgement object alone grants no access.

Decline uses exactly requestId, offerKey and decision:decline under the named
recipient's current credential. Cancel uses the same shape with decision:cancel
under the original still-current coordinator. Neither changes responsibility.
Exactly one terminal decision wins. Another distinct terminal command conflicts.

## Context, generations and receipts

The briefing contains metadata for the selected source and bounded pages of its
observations and reviews through contextThroughSequence. It preserves original
uncertainty notes, including when a review's observation is outside the current
page. Recording planes and labels identifying synthetic scene objects are not
copied. The source remains unsigned simulated evidence, with
sourceIdentityAuthenticated:false, physicalThermalVerified:false and
physicalFlightEnabled:false.

Later observations and reviews do not invalidate a pending assignment transfer.
They appear separately in newerContext and are counted at acceptance without
being described as reviewed. This selected-source snapshot is not a complete
incident picture or a live vehicle feed.

The offer's assignment and membership bindings stay fixed. Revocation and
regrant, role changes and a coordinator moving away then returning invalidate
the old offer. Acceptance independently checks current outgoing and incoming
platform eligibility. It does not retain a sender credential or provide a
distributed token-cancellation fence.

Acceptance commits both role/version changes, coordinator pointer, common
incident version and one terminal audit together. Ordinary membership mutation
cannot perform this transfer. A reversal requires another fresh handover.

Mutation receipts contain incident, offer, event and replayed. Keep the same
requestId and exact body when retrying. The request fingerprint also binds the
actual actor. Changed content or another actor under that incident request key
conflicts. Every retry reauthorizes current access before returning a historical
event and fresh incident. It never repeats the transfer or restores revoked
membership. No caller-wide expectedVersion is required; internal current-row
compare-and-swap still serializes the atomic changes.

## Expiry, closure and purge

A new command result retains the minimum offer and incident expiry through the
actual transaction commit and final HTTP release. If commit succeeds but the
response crosses expiry, the response is withheld. Read current incident
responsibility before deciding what happened; a withheld response does not undo
the transfer. An explicit later terminal read or exact historical retry can
remain available through incident retention without an actionable briefing.

Expired pending offers are unavailable. A default desk can omit them, and a new
valid offer can be proposed. Closure refuses all new handover commands and
command replay. Authorized read-only terminal history remains available until
retention; closed pending offers do not remain actionable. Accepted purge freeze
or retention expiry denies handover content and replay. No expiry scheduler or
automatic cancellation event is created.

Handover offers and terminal decisions are private append-only PublicSafetyAudit
rows. Their lookup fields, source references, fingerprints and details are erased
with the existing accepted purge-v1 audit group. The fixed inventory and
previously accepted plans are unchanged. No per-offer copy survives in custody or
purge receipt metadata. Native diagnostic exclusions and explicit field redaction
also cover the protocol. Existing downloaded, exported, backed-up or diagnostic
copies remain subject to the exclusions in [local purge](public-safety-purge.md).

The library functions live in resources/functions/drone/public-safety/access/
handover.ts; native Actions and Gates adapt the same interface to HTTP. The
authorized live workspace, sector/team responsibility and operational/hardware
qualification remain open in issue23.
