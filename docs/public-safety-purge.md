# Accepted local purge

The server exposes a separate local purge acceptance contract. Existing
`local-managed-v1` custody enrollment does not authorize deletion. The operator
must explicitly enable `PUBLIC_SAFETY_PURGE_ENABLED`; its default is false.
No automatic sweep is registered in this implementation.

The five native Stacks Actions use the ordinary authentication middleware and
current incident custody. Coordinators and evidence custodians can read the
preview, receipt and events with a read scoped human credential. Acceptance and
retry require coordinate scope. The existing coordinator only custody member
revocation route continues to control access during frozen progress and after
completion. Delegated, non-user and session-only credentials do not qualify.

All paths below begin with
`/api/public-safety/incidents/{incident}/retention/purge`.

| Method | Suffix | Result |
| --- | --- | --- |
| GET | `/preview` | Current aggregate inventory, or accepted frozen inventory and existing purge key. |
| POST | collection | Accept one exact eligible inventory. New acceptance returns 202, identical actor and canonical command replay returns 200. |
| GET | `/{purge}` | Current minimal status or completed receipt. |
| GET | `/{purge}/events` | Minimal events, with canonical `after` and `limit` cursors. |
| POST | `/{purge}/retry` | Wake the same accepted plan. New retry returns 202, identical actor and canonical command replay returns 200. |

Mutations authorize before reading at most 8192 bytes of JSON. Native cookie
CSRF protection applies. Unknown queries and extra input fields are refused.
Responses use private no-store caching, Vary Authorization and Cookie, and
nosniff. Errors contain a sanitized error field without database or filesystem
diagnostics.

Acceptance binds current incident and retention versions, the aggregate
inventory digest, policy `local-managed-purge-v1`, coverage
`active-db-and-registered-namespace-v1`, a request UUID, explicit receipt retention
of 1 to 365 days, and every fixed exclusion. It is available only after the
incident deadline, with an enrolled scope and no pending or held review.
Acceptance freezes content mutation and cannot be canceled. Retry does not
replace the accepted inventory or change destruction authority.

Before acceptance, the preview labels its inventory `current-preview`. After
acceptance, current authorized custodians can discover the purge without the
original request through `existingPurgeKey`; the preview labels the immutable
accepted aggregate inventory `accepted-frozen` and reports `already-accepted`.
It does not reopen expired content or inspect the filesystem.

During frozen progress, legacy retention preview, read and event endpoints
return 409. Use the purge status API. After completion, legacy custody returns
a fixed minimal tombstone and retired-history event page. Receipt expiry
returns 404 even if disabled or stopped execution makes metadata cleanup
overdue. Custody revocation remains current-authorized throughout these states.

Completed receipts carry their release deadline in private object metadata.
Services check it after the actual transaction commits. HTTP adapters check it
after awaiting the service and creating the JSON response. The final incident
boundary checks again after awaited middleware and response cloning. Public
DTOs and headers gain no deadline capability. These checks gate application
release and cannot recall bytes already handed to the network or client memory.

Status and events contain aggregate counters and safe outcome codes. They do
not expose source IDs, notes, file paths, inodes, file hashes or private ownership
plans. `contentDeletionPerformed` records acknowledged committed payload removal
or unlinks, not acceptance or reconciled absence. Historical diagnostics,
offline exports, downloads, backups and replicas, process memory and media
residuals are outside the accepted scope. The receipt always reports
`diagnosticsErased: false`, `allCopiesErased: false` and `mediaErasure: false`.

Acceptance stores a durable plan. A trusted server process advances it through the native
`PublicSafetyPurgeSweep.dispatchNow({ purgeKey })` Job and awaits each complete batch.
The handler checks the operator flag even on direct dispatch. Each batch permits at most one
purge, 16 units, 100 DB rows per deletion unit and 32 MiB of conservative file-byte reservations.
Its five-second cooperative budget is checked between fully awaited units, rather than abandoning
an active effect. No Scheduler registration or automatic worker-drain guarantee is provided.

The local executor requires the authoritative SQLite database and exact registered private
filesystem identities. Unknown process visibility, active readers, mounts or changed ownership
preserve files and block the filesystem arm. Accepted DB removal may proceed independently.
Forced native connection retirement can require process exit before SQLite writes recover;
see [Stacks #2922](https://github.com/stacksjs/stacks/issues/2922). The executor uses no GC or
replacement-connection workaround. Receipt cleanup can be overdue while execution is disabled.

The loopback HTTP qualification uses disposable SQLite and private registered
artifacts in both native route modes, with actual native authentication,
permissions and custody. It verifies wire behavior without substituting a mock
for the core service. The fixture also advances the actual awaited native Job. Complete process
visibility permits the completed tombstone and current revocation checks;
inspection refusal preserves the tree and reports completion qualification as
unavailable. A labeled persisted overdue-receipt reconstruction verifies that
reads return 404 while disabled cleanup leaves metadata in storage. It does
not demonstrate a day of elapsed time. Separate short future receipt dates
are crossed through real awaited event SELECTs, native post-COMMIT release
callbacks and late HTTP middleware in both route modes; each expired response
returns private 404. The fixture keeps the normal wall clock running. Controlled Linux process and mount
namespace behavior and genuine crash recovery require separate core
qualifications. HTTP tests do not establish physical, media, power-loss or
all-copy erasure.
