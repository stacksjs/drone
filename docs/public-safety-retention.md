# Incident retention enrollment and hold review

Retention custody uses native Stacks accounts, token scopes, current membership, Gates and
model-derived persistence. It provides explicit enrollment and an append-only hold review history.
It does not delete content, schedule destruction, manage offline exports or establish legal authority.

The incident's existing server deadline still denies all imagery, configuration, annotations,
review notes and ordinary audit reads when it expires. A hold preserves the current application
records; it does not extend permission to read expired content. Physical outputs remain inhibited.

## Explicit enrollment

Existing incidents remain unenrolled until a coordinator or evidence custodian explicitly enrolls
them. A migration does not authorize removal of existing data. Enrollment is available for active,
closed and expired incidents through a separate custody permission check. It never makes an expired
incident available through the content API.

First read the retention preview. It returns the incident key and version, deadline, expiry status,
original hold declaration, aggregate source/observation/review counts and an inventory digest.
It excludes geometry, purpose authority, configuration, individual source digests and private notes.
`managedArtifactCount` counts registered managed attempts. The current inventory digest includes
deterministic managed artifact/file metadata; an earlier enrollment digest remains historical
acceptance. `legacyOfflineExportsManaged: false` continues to exclude old offline copies.

Submit that inventory digest and incident version with `policyVersion: 'local-managed-v1'` and a
new canonical lowercase UUIDv4 `requestId`. The final transaction recomputes the inventory under
the incident lock and rechecks current credentials, platform permission and membership. A changed
inventory or version returns 409. Enrollment of already expired data is explicit in the preview;
it still performs no deletion.

An original hold declaration of `none` starts in `none`. `declared-review-required` starts in
`pending-review`. The latter requires an explicit custodian decision. Neither an overdue decision
nor a scheduler tick silently releases a hold.

## Custody roles and current access

| Operation | Current coordinator | Evidence custodian | Other incident roles |
| --- | --- | --- | --- |
| Read minimal preview, scope and events | Yes | Yes | No |
| Enroll and review a hold | Yes | Yes | No |
| Revoke an active noncoordinator member | Yes | No | No |
| Read expired source or note content | No | No | No |

Reads require native `public-safety:read`; mutations require `public-safety:coordinate`. Every call
also requires the native platform permission and an active incident membership. Neither a scope
nor knowledge of an incident key grants a role. Token, account, platform and membership revocations
are rechecked inside the final mutation transaction after the HTTP preflight.

Custody revocation changes the actual incident membership row. It grants no roles, transfers no
coordinator duty and changes no vehicle authority. It remains available after closure and expiry,
so a former custodian cannot keep receipt access through an unmaintained copied access list.
The current coordinator cannot revoke themselves or another coordinator through this operation.

## Hold decisions and history

A decision is `retain` or `release`. Both require an opaque `caseReference` of 1..128 ASCII letters,
digits, periods, underscores, colons or hyphens. Use a case identifier, not a narrative or private
incident note. This identifier remains in the custody history.

`retain` requires `reviewDueAt` in canonical UTC ISO form with milliseconds, strictly in the future
and at most 30 days from the server's current time. This is an application review interval, not a
legal retention maximum. A held decision that passes its review date remains held and reports
`reviewOverdue: true`. A pending original declaration reports that review is required without
inventing a reviewer or a due date. `release` requires `reviewDueAt: null`.

Each accepted custody mutation advances the common incident version and its own retention version
once, and appends one human custody event in the same native transaction. Event actor and time
come from the server. These events are the retention audit; they do not impersonate the coordinator
in a background worker or copy source content into the ordinary incident audit.

Use `expectedRetentionVersion` for hold and custody revocation operations. Competing requests with
the same version have one winner. An identical `requestId` retry returns the original event and a
fresh current scope with `replayed: true` after current authorization. Reusing the same ID with
changed fields or a different operation returns 409. A replay does not undo a later hold decision.

## Native API

All paths below are relative to `/api/public-safety/incidents/{incident}`.

| Method | Path | Exact body or query |
| --- | --- | --- |
| GET | `/retention/preview` | No query |
| POST | `/retention/enrollment` | `{ expectedVersion, policyVersion, inventoryDigest, requestId }` |
| GET | `/retention` | No query |
| POST | `/retention/hold` | `{ expectedRetentionVersion, decision, caseReference, reviewDueAt, requestId }` |
| GET | `/retention/events` | Optional `after`, `limit` |
| POST | `/retention/revoke-member` | `{ expectedRetentionVersion, userId, requestId }` |

Mutation bodies are limited to 8 KiB and are read only after custody authorization. Native cookie
CSRF remains enabled. Unknown fields, accessors in direct library input, noncanonical IDs,
unsupported queries and duplicate cursors are refused. Responses and errors use the same private,
uncacheable, sanitized boundary as the content API.

Event pages use a retention sequence cursor with default and maximum page size 100. Pass the
returned `cursor` as the next `after` while `hasMore` is true. Every page checks current custody
access. Retention sequences are separate from incident versions; ordinary record appends can
advance the incident version without creating a retention event.

## Remaining deletion workflow

[Managed source datasets](public-safety-managed.md) add explicitly requested private copies and
read-only reconciliation. They do not reinterpret enrollment or a hold as purge acceptance.

Custody projections explicitly report `purgeImplemented: false` and
`contentDeletionPerformed: false`. Retention declarations and hold decisions remain alongside the
current stored source, annotation and review data. This history has no automatic deletion job yet.

The managed registry now records explicitly requested binary and derivative files. The next tracer
needs separate inventory-bound purge acceptance, resumable deletion progress, a system actor ledger
and exact receipts for controlled files and database rows. There is no atomic transaction between
SQLite and the filesystem. Failures must remain visible, and interrupted work must resume against
the same owned inventory. Existing enrollment never grants destructive acceptance.

Existing offline `--output` directories, downloads, external logs, backups and uncontrolled copies
are not enrolled by these APIs. Future receipts must distinguish application row removal and
verified pathname absence from forensic media erasure. Managed deletion, recipient-bound atomic
handover, the authorized workspace and live coordination remain open in issue #23, together with
operational and hardware qualification.
