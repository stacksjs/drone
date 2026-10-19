# Authenticated incident access

The collection simulator and the incident access API have separate evidence boundaries.
The API authenticates a native Stacks account and authorizes persisted incident membership.
It does not authenticate an offline collection producer, qualify an operator's legal authority,
restore a vehicle runtime or enable physical outputs.

## Local setup and credentials

Run migrations through Buddy. The native workflow applies the owned model migrations and
idempotent auth/RBAC infrastructure without resetting existing data:

```sh
./buddy migrate
./buddy user:add operator@example.invalid --name 'Incident Operator'
./buddy user:list
./buddy public-safety:access 1 --mode coordinate --create-incidents --minutes 30 --output /tmp/new-incident-credential
```

Replace `1` with the existing account's actual ID. `user:add` is native account bootstrap;
it displays a generated password once when no password is supplied. The incident command
creates no accounts or administrator roles. It requires local access to the configured database,
grants the narrow native permissions below and saves an access-only native token in a new
0700 directory with a 0600 `token.json`. Its stdout contains metadata and the file path,
never the token. Keep that credential private. Token lifetime is 1..60 whole minutes, with
no refresh token. Existing output paths are refused before any grant or token mutation.

Read mode is the default. Coordinate mode adds the mutation scope. `--create-incidents`
requires coordinate mode and explicitly grants platform incident creation. These grants do
not create membership in an existing incident or transfer vehicle authority. Account creation,
password handling and token hashing remain native Stacks behavior.

The command runs through Buddy in the configured application. The standalone simulator binary
does not include this database-administration command. A failed native token insert rolls back
its permission grants and removes its unfinished credential output. File and database commits
are separate resources: a process crash can leave an inactive file before database commit,
or a valid private file before a success message. Exclusive retry refusal preserves the
artifact for inspection; this is not a cross-resource crash-atomic protocol.

## Native identity and incident roles

Every call requires the native `public-safety:access` permission in the `web` RBAC guard.
Creation also requires `public-safety:create`. Reads require token scope
`public-safety:read`; creation and mutations require `public-safety:coordinate`. Native wildcard
personal tokens retain their native semantics. Delegated OAuth credentials and session-only
identity cannot satisfy this token-scoped API. Bearer and native token-cookie credentials
are accepted. Cookie writes require the matching native `X-CSRF-Token` cookie and header;
a body-only CSRF token is unavailable because these routes defer body parsing until authorization.

| Incident role | Read incident | Read audit | Change membership or close |
| --- | --- | --- | --- |
| Current coordinator | Yes | Yes | Yes |
| Pilot | Yes | No | No |
| Observer | Yes | No | No |
| Reviewer | Yes | No | No |
| Evidence custodian | Yes | Yes | No |

Creation installs exactly one coordinator. Membership changes cannot mint another coordinator,
remove or demote the current one, or perform handover. Use the separate two-phase
[incident coordination handover](public-safety-handover.md), currently under qualification.
An account needs both platform eligibility and active incident membership.
Client-supplied actor, grantor or principal fields grant nothing and are rejected by mutation schemas.

The service resolves the current native request and account, then checks the current token and
cache-free native SQL permission store. Mutations repeat these checks on the active native
transaction connection with current incident membership, retention and version. They do not rely
on warmed `Auth.tokenCan` or `Rbac.hasPermission` caches. Authorization takes effect at that fresh
transaction check; a later concurrent global revocation does not promise cancellation of an
operation that already passed it.

## API

| Method | Path below `/api/public-safety` | Input |
| --- | --- | --- |
| POST | `/incidents` | Exact `{ config }`, a validated `PublicSafetyConfig` |
| GET | `/incidents/{incident}` | Incident key |
| PUT | `/incidents/{incident}/members` | Exact `{ expectedVersion, userId, role }`; null role revokes |
| POST | `/incidents/{incident}/close` | Exact `{ expectedVersion }` |
| GET | `/incidents/{incident}/audit` | Optional decimal `after` sequence and `limit` |

Create bodies are limited to 256 KiB; membership and close bodies to 8 KiB. Native auth and
incident Gate preflight run before the bounded wire-body read. Unknown fields, invalid content
types, malformed JSON and excess bytes are rejected. Owned responses, including native auth and
CSRF refusals, are sanitized and carry `Cache-Control: private, no-store` and credential Vary headers.

Incident projections include the canonical config, status, current incident version, retention
deadline, coordinator ID and the requesting member's role/version. `identityAuthenticated: true`
describes the authenticated API identity. It does not authenticate a simulator or establish the
config's declared legal purpose. No password, token row or account email is included.

Membership and closure require the last observed incident version. A stale version returns 409.
The incident update, membership change and append-only audit record commit in one transaction.
Each audit sequence equals its incident version. An audit insertion failure rolls back the
entire change. Concurrent requests with the same expected version have one winner.

Audit reads return `{ entries, cursor, hasMore }`. The default page is 100 entries, with a
maximum of 100. `after` defaults to 0 and ranges from 0..2147483647. Supply the returned cursor
as the next `after` while `hasMore` is true. Every page rechecks current access. Ordinary
members cannot enumerate audit actors.

Creation requires a future retention deadline within 366 days. Expiry denies incident and audit
reads as well as writes, using server UTC. Closure rejects later mutations but permits scoped
reads until expiry. Neither operation automatically erases source files, derivatives, backups
or uncontrolled copies. A declared hold does not bypass expiry or prove a reviewed legal hold.
Content results are checked after actual transaction completion and again after awaited HTTP
middleware. If expiry withholds a mutation response after COMMIT, its committed change remains;
the response gate does not roll back that change or recall bytes already released to clients.
The [retention custody API](public-safety-retention.md) adds explicit enrollment and hold review.
[Accepted local purge](public-safety-purge.md) is a separate, default-disabled policy for active
incident DB payload and registered files. Enrollment alone never authorizes that removal.

## Generic data boundaries

The application selects no framework default route bundles and no generated model REST APIs.
Sensitive models expose neither `useApi` nor search indexing. Its global native middleware
also refuses generic `/api/dashboard`, `/models` and `/dashboard` surfaces before model reads,
even if a deployment explicitly mounts the dashboard bundle. The custom incident API remains
available through its own native Actions and Gates.

Per-model `dashboard.enabled: false` is a visibility flag, not an incident authorization policy.
The application's boundary is required for the installed framework version. The reusable native
server exposure control is developed separately; it must not be confused with row membership
or assumed to protect custom domain endpoints automatically.

## Evidence and remaining workflow

Tests use actual native models, generated SQL, temporary file-backed SQLite, real minted tokens,
Gates, persisted permissions and loopback HTTP in both native routing modes. They exercise
revocation, retention, version conflicts, rollback, pagination, private credential provisioning,
cookie CSRF, unread unauthorized bodies and alternate generic model routes. They do not mock
Auth or the ORM, reset the application's database, or establish production identity-provider,
distributed revocation or vehicle evidence.

The [source, observation and review functions](public-safety-records.md) extend this access module
with immutable verified collection sources, explicit pixel declarations and append-only review.
The [retention custody functions](public-safety-retention.md) add minimal status and explicit hold
review after expiry, without reopening content access or deleting data.
The [separate purge module](public-safety-purge.md) records explicit accepted removal and minimal
receipts, with declared exclusions. The [handover module](public-safety-handover.md) transfers
incident coordination after explicit recipient acknowledgement. Issue #23 remains open for
sector/team assignments, an authorized operator workspace and live observations, plus jurisdiction, hardware,
firmware interoperability and operational qualification.
