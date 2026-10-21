# Private managed source datasets

A current coordinator or evidence custodian can explicitly create a managed dataset from an
admitted incident source. The server replays the complete source and renders the same canonical
recording, PNG images, uint16 little-endian thermal planes, support bytes and unsigned manifest
as the offline exporter. Operator observations and review notes are excluded from this dataset.
The source remains synthetic and unsigned. Native account authorization does not authenticate
the producer, qualify physical thermography or enable flight outputs.

Creation requires existing `local-managed-v1` retention enrollment. Enrollment and artifact
creation are separate explicit actions. Neither authorizes deletion. Managed artifacts report
`purgeImplemented: false` and `contentDeletionPerformed: false`; legacy offline exports and
downloaded copies remain outside the managed registry.

[Accepted local purge](public-safety-purge.md) is a separate policy with explicit inventory
acceptance, durable progress and a minimized receipt. It freezes these content operations before
removing registered namespace entries and accepted DB payload. Existing enrollment and dataset
requests never grant that destructive authority.

## Native API

Paths below are relative to `/api/public-safety/incidents/{incident}/managed-artifacts`.

| Method | Path | Exact body or query |
| --- | --- | --- |
| POST | collection | `{ expectedVersion, expectedRetentionVersion, sourceDigest, datasetProfile, requestId }` |
| GET | collection | Optional `afterId`, `limit`, or a sole `requestId` |
| GET | `/{artifact}` | No query |
| GET, HEAD | `/{artifact}/files/{file}` | No query |
| GET | `/{artifact}/events` | Optional `after`, `limit` |
| POST | `/{artifact}/reconcile` | `{ expectedVersion, expectedArtifactVersion, requestId }` |

`datasetProfile` is exactly `owned-public-safety-dataset-v1`. Request and artifact keys are
canonical lowercase UUIDv4 values, source digests are 64 lowercase hexadecimal characters,
and file IDs are positive canonical integers. Mutations accept at most 8 KiB of JSON after the
native Gate permits the action. Native token-cookie CSRF remains enabled. Actor, root, path,
filename and other extra fields are refused.

Collection pages return `{ entries, cursor, hasMore }`. Pass the cursor as `afterId`; event
pages use `after`. Page size defaults to 100 and cannot exceed 100. A request lookup returns
current safe metadata and cannot be mixed with pagination. Duplicate or unknown query fields,
including the collection alias `after` and event alias `afterSequence`, are refused. Discovery
and reads do not rerender or publish files.

| Operation | Required native scope | Permitted current members |
| --- | --- | --- |
| Create or reconcile | `public-safety:coordinate` | Current coordinator, evidence custodian |
| List, read or download | `public-safety:read` | Every active incident member |
| Read artifact events | `public-safety:read` | Current coordinator, evidence custodian |

Every operation also checks native credentials, platform permission and current membership.
Session-only and delegated/non-user identities do not acquire these token-scoped privileges.
A pilot's source-upload duty grants no automatic managed-copy privilege. Creation and reconcile
require an active, unexpired incident. Closed incidents remain readable until expiry; expired
artifacts, files and event catalogs return 404 even during a hold.

## Attempts, receipts and reconciliation

A new successful foreground create returns 201 with `{ artifact, event, replayed: false }`.
An identical authorized request replay returns 200 and the original attempt's current state;
it does not publish again. Changed fields or actor under the same request ID conflict with 409.
A new noncomplete receipt, if actually returned by the service, uses 202. Publication failures
remain failures and are not converted into accepted receipts. Discover a lost response by its
request ID before explicitly deciding on another attempt.

Intent, ownership and publication are separate committed lifecycle events. A complete create
advances artifact and common incident versions three times. Reconcile commits a human claim and
then a classification, normally advancing both versions twice. Artifact events retain their own
sequence; these transitions do not advance the retention hold sequence. A receipt reports the
actual durable stage and current incident version, without claiming atomic SQL/filesystem rollback.

The native prepared writer exclusively creates synced empty private files. Their exact observed
identities are committed before any payload publication through the same live handle. A receipt
is metadata, not a restart writer. Read-only reconciliation can classify exact completion,
interruption or blocked/uncertain ownership. It does not recreate directories, resume a lost
writer, overwrite files or delete anything. Errors preserve physical state for reconciliation.

## Binary delivery and expiry

Downloads buffer one bounded, verified registered file after checking the complete artifact's
plan, root, marker, identities, private modes, length and SHA-256. All file descriptors close
before the service returns. The HTTP layer returns an attachment with a fixed allowlisted MIME,
`private, no-store`, `Vary: Authorization, Cookie` and `nosniff`. It sets the exact unencoded
source length. Native negotiation can add gzip/deflate, remove that length and add
`Accept-Encoding` to `Vary`; the decoded bytes remain exact. Request `Accept-Encoding: identity`
when comparing the source byte count with `Content-Length`. No invented content encoding or
global compression disable is used. An unacceptable representation can produce the native empty
406 response with `no-store`, without file content or attachment metadata.

Range and conditional headers still return the full verified 200 representation when its encoding
is acceptable, with no partial or 304 shortcut. HEAD uses the same native authorization and file
verification. There is no static path, `Bun.file` response or signed download URL.

After the awaited service result, HTTP synchronously checks the captured retention deadline
immediately before constructing its Response. A server-private WeakMap carries that deadline
through the final application response clone, which checks again after awaited middleware.
No deadline header, private path or account state is exposed. Native compression and network
continuations operate on already released memory bytes. This boundary cannot recall bytes after
release or establish atomicity between database authorization and network delivery.

## Private storage configuration

The operator provisions the default private `storage/app/private/public-safety-managed` directory
as the service account with mode 0700, or configures an existing private absolute directory through
`PUBLIC_SAFETY_MANAGED_ROOT`. The API does not provision an arbitrary root. Canonical roots must
remain outside public/static roots and preserve their qualified identities. Configuration drift
does not relocate or adopt existing artifacts. Unsupported or uncertain ownership blocks writes.

Drone's installed native version does not contain the prepared export. The explicit
[source bridge provenance](https://github.com/stacksjs/drone/blob/main/resources/functions/artifacts/native-storage/PROVENANCE.md) records
the qualified published native source used here. It does not imply a dependency upgrade.
Deliberate native SQLite connection retirement is tested as a terminal process boundary. The
captured transaction correctly refuses further file effects, but current Bun/native driver
behavior can retain a write lock until process exit after an active transaction is closed.
[Stacks #2922](https://github.com/stacksjs/stacks/issues/2922) tracks the verified reproduction.
These checks do not promise that the same process immediately resumes writing after forced
connection closure. The library adds no garbage-collection workaround or replacement writer.

Local process-crash and filesystem checks do not establish hardware power-loss durability,
hostile-host protection, media erasure, uncontrolled-copy removal or purge acceptance.

The [resource qualification](public-safety-managed-budget.md) derives a tighter output
bound for the pinned replay profile and codec. The manifest-inclusive 32 MiB guard
remains enforced before publication intent.
