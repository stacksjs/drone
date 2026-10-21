# Authorized incident workspace

Open `/incidents` to connect an existing native personal credential and incident
key. This read and command tracer combines existing incident, source, observation,
review and coordination interfaces in one authorized screen. It does not yet
start a simulator or display a live vehicle feed. See
[ADR25](https://github.com/stacksjs/drone/blob/main/docs/adr/0025-authorized-incident-workspace.md) for the accepted design and
[incident access](https://github.com/stacksjs/drone/blob/main/docs/public-safety-access.md) for account provisioning.

## Identity and current access

The connection form accepts an existing personal Stacks credential and incident
key. The credential travels in Authorization headers to fixed same-origin API
paths. It remains in the active request closure; the input is cleared after
connection. Disconnect, identity change or access refusal discards the connection
and private view. Tokens are excluded from URLs, server-rendered data, browser
storage and logs. Reloading requires a new connection.

Native Auth, Gates, current SQL permissions, purpose, membership and retention
apply on every read. Session-only and delegated credentials retain the existing
refusals. Read-only credentials can inspect permitted history without mutation
controls. Current role and action flags guide the screen; existing commands
independently reauthorize when submitted.

## Snapshot and pages

GET /api/public-safety/incidents/{incident}/workspace returns a bounded coherent
snapshot. Expensive canonical source verification occurs before the final native
transaction. That transaction uses one incident sequence, fresh authority and
complete staged source/configuration checks for all returned sections.

| Option | Meaning |
| --- | --- |
| sourceDigest | Explicit selected canonical source digest; omitted means no selection. |
| sourcesAfterSequence | Source catalog keyset position, initially 0. |
| contextCursor | Returned selected-source context cursor, bound to scope, source and fixed cutoff. |
| offerKey | Explicit historical handover offer; omitted selects the currently visible offer. |
| handoverAfterSequence | Position in the offer's independent briefing, initially 0. |
| membersAfterUserId | Coordinator recipient-list keyset position, initially 0. |
| limit | Per-page row bound, 1..100, default 50. |

Unknown or repeated options, noncanonical integers and mismatched cursors are
refused. Catalog and recipient pages return their own cursor and hasMore. Context
pages retain their original cutoff while counting later selected-source records
separately. Neither the ordinary selected source nor its cursor supplies an
acknowledgement for a different handover source.

The response identifies the actual account, scope/incarnation, common
throughSequence and informational availableUntil. It includes incident metadata,
a source catalog page, optional selected-source context, the authorized handover
desk, a coordinator-only recipient page and current action flags. Recipient rows
contain account ID, role and membership generation. They neither expose the
platform account directory nor assert the recipient's current platform
eligibility. The offer command checks that eligibility itself.

Rows are independently bounded and the serialized snapshot is capped at 4 MiB.
It contains no canonical recording or image/thermal planes. Source imagery uses
the existing separately authorized source interface. Support and original
uncertainty remain attached to observations and reviews. An account attribution
does not authenticate an unsigned recording producer or qualify a physical
sensor.

Private deadline tags survive nesting, actual transaction COMMIT and final JSON
release. The minimum applicable credential, incident and pending-offer deadline
cannot be extended by embedding a projection. availableUntil is informational,
not an access capability. Closed incident history follows existing read policy;
accepted purge freeze and retention expiry deny content.

## Refresh stream and reconciliation

GET /api/public-safety/incidents/{incident}/workspace/events uses the native
Stacks broadcast response. It carries only fixed refresh hints. Each delayed
check captures the subscriber's complete async context before any transaction,
then rereads current native authority. A valid writer cannot authorize a revoked
reader. A final adapter rechecks current access and expiry before releasing a
native chunk.

Hints register with native transaction completion, including a durable write
whose response is later withheld. Rollback and exact replay announce no new
write. A publication failure cannot reverse a committed command. The screen
subscribes before reading, coalesces concurrent refresh requests and periodically
reads again. Reconnection repairs missed notifications. Stream frames do not
carry prior snapshots, credentials, imagery, private notes or retained replay.

The stream has finite global, account, incident, frame, pending-check and lifetime
limits. Cancellation closes its reader, subscription and timers. Released bytes
cannot be recalled. A fresh SQL decision is not a distributed revocation fence.

## Human commands and conflicts

Source selection remains explicit. Observation and review forms use the
displayed source and current incident version. Handover uses the independent
offer digest, assignment and briefing cutoff, with explicit acknowledgement of
the displayed uncertainty. See [record commands](https://github.com/stacksjs/drone/blob/main/docs/public-safety-records.md) and
[coordination handover](https://github.com/stacksjs/drone/blob/main/docs/public-safety-handover.md) for authoritative schemas.

An identity or scope change clears old source selections, cursors,
acknowledgements, drafts and pending retries. Old asynchronous completions cannot
restore that view. A version conflict preserves the human draft but requires a
fresh binding and deliberate resubmission. Observation and review commands are
not blindly retried after an ambiguous response. Handover retains its existing
exact actor/request replay rules.

This tracer adds no persistent execution model, outbox, derivative cache, private
filesystem output, migration or purge-v1 inventory change. Volatile process and
browser memory remain outside forensic erasure claims. Real in-progress
simulation, explicit completed-source admission, sector/team responsibility,
searched-area qualification and operational/hardware acceptance remain separate
work. Original issue23 acceptance criteria remain open.

## Verification

The mandatory `workspace-browser` CI job compiles the actual STX component and
uses disposable native accounts, minted credentials, generated migrations and
file-backed SQLite. It exercises source imagery, two original observations,
append-only review, recipient-confirmed handover, ordinary 30-second stream
renewal, read-only access and revocation. It checks escaped text, draft binding,
mobile overflow, empty local/session stores and credential omission when JavaScript
is unavailable. It uploads only compiled public HTML and selected screenshots.

On a host with an existing Chrome binary, run the same opt-in fixture:

```sh
WORKSPACE_BROWSER_QA=true BROWSE_BROWSER=/path/to/google-chrome bun test tests/unit/public-safety-workspace-browser.test.ts
```

The ordinary suite skips the browser lifecycle test; that skip does not qualify
rendered behavior. Separate native HTTP tests cover rollback, current authority,
retention crossings through COMMIT and final response release, stream budgets
and cleanup. These checks establish the bounded software contract, not live
vehicle operation or physical sensor performance.
