# Authenticated patrol review ledger

The patrol review API records owner-scoped intent, review decisions and one consumption acknowledgment in native Stacks models. It does not start a simulation, launch a vehicle, grant charging authority or hand work to a runtime. Every successful response carries `actorIdentityAuthenticated: true`, `bindingIdentityAuthenticated: false`, `launchAuthorized: false`, `chargeAuthorized: false`, `physicalFlightEnabled: false`, `executionState: "not-requested"` and `handoff: null`.

This API is separate from [finite patrol recording and replay](https://github.com/stacksjs/drone/blob/main/docs/patrol-recording.md). Recording replay checks an unsigned local summary. Authenticated review records a server-authenticated actor and durable history; it does not authenticate the caller's declared vehicle, pad or frame.

## Native access and routes

The application uses native Stacks Actions, Gates, token authentication, web-guard permissions, model-derived migrations and SQLite transactions. Deploy the normal Stacks application with its framework defaults available. The dedicated `PatrolAuth` middleware delegates to the current defaults Auth handler once. Its error adaptation accepts only the observed native Error tuples `SQLITE_BUSY` with numeric errno 5 and `SQLITE_BUSY_SNAPSHOT` with numeric errno 517, mapped to 503 before the router loses their identity. Message text, other codes and non-Error values do not qualify. Other authentication behavior is delegated unchanged; unrelated routes retain their existing middleware.

The application excludes `/models`, `/dashboard`, `/api/dashboard` and their subpaths globally, including when native generic routes are registered. Keep that boundary in place. Installed Stacks 0.75.221 model discovery does not independently filter these private definitions by `dashboard.enabled`; the application boundary supplies generic discovery/read/write isolation. The four explicit owner-scoped patrol endpoints are the release path. This does not qualify arbitrary custom aliases for generic Actions.

All four endpoints require a current personal user token. Cookie credentials use native CSRF protection for POST. Database sessions alone do not satisfy the personal-token requirement. Delegated OAuth resource tokens do not qualify. Never put a token in a URL, public file or committed example.

| Method | Path | Required token scopes and web permissions |
| --- | --- | --- |
| POST | `/api/patrol/reviews` | `patrol:create` |
| GET | `/api/patrol/reviews/{schedule}` | `patrol:read` |
| POST | `/api/patrol/reviews/{schedule}/occurrences/{due}/decision` | `patrol:review`; approving also requires `patrol:consume` |
| POST | `/api/patrol/reviews/{schedule}/occurrences/{due}/consume` | `patrol:consume` |

Every operation also requires web permission `patrol:access`. Token scope `*` satisfies scopes; it does not bypass permissions. Authority is rechecked inside the transaction rather than relying only on the first middleware result. Schedules are visible only to their owner. A replacement token with read authority may read history, but cannot adopt an original token's mutation receipts or approval.

## Create immutable intent

Send JSON with exactly `requestId`, `scheduleKey`, `input` and `binding`. A request ID is a lowercase canonical UUID v4. A schedule key starts with a lowercase letter and contains at most 40 lowercase letters, digits or hyphens.

The first profile accepts one or two approved flight declarations from the existing finite patrol model. The only due times are `1767225600000` at `atMs: 2000` and `1767225660000` at `atMs: 60000`. These are model anchors on January 1, 2026, not dates when the server will launch anything. Input requires `profile: "nominal"`, `unsignedLocalReview: true` and `enableCharge: false`. Charge reviews are outside this API.

The eight binding fields are declared context: `vehicleId: "navigation-vehicle"`, `padId: "pad"`, `planId: "local-survey-demo"`, `profile: "nominal-contact-partial-charge-v1"`, canonical positive uint64 strings `sessionId` and `bootId`, `reference` and `origin`. Reference is the boot ID followed by a colon and five canonical nonnegative safe-integer reset counts, for example `55:0,0,0,0,0`. Origin is exactly the JSON string `{"latitudeDeg":0,"longitudeDeg":0,"ellipsoidHeightM":100}`. The API does not observe or verify these declarations against a live vehicle.

A fresh create returns 201 and a bounded receipt. The owner GET returns the retained canonical input, binding, digests, occurrence states and complete bounded audit. A schedule has one immutable revision, one or two occurrences, and a version from 1 through 5. Each owner may create at most 16 schedules over this ledger's lifetime; there is no delete/reset endpoint.

## Review and consume

A decision POST body contains exactly `expectedVersion`, `requestId`, `scopeDigest` and `decision`, where decision is `approve` or `deny`. A consume POST contains exactly `expectedVersion`, `requestId` and `scopeDigest`. Use the current version and the server-issued occurrence digest from the owner GET. The due path is the canonical decimal UTC millisecond value.

An occurrence begins `awaiting-review`. Denial is terminal. Approval records the reviewing token and a server UTC lease lasting at most 120 seconds, capped by that token's absolute expiry. Only the same current original token, with current consume scope and permission, may consume an approved occurrence once before expiry. Consumption appends an audit fact and returns `consumedNow: true` only for the newly committed acknowledgment. It does not authorize launch or create an execution session.

Version comparison, occurrence state, audit insertion and receipt projection occur in one transaction. A failed write rolls back the protected ledger. There is no automatic mutation retry.

## Idempotency and historical facts

Request IDs are namespaced by owner and schedule key. Reusing an ID with changed operation, tuple, expected version or payload conflicts. The same UUID under another schedule key is a separate namespace.

An exact POST replay requires current authority and the same original token. After validating the complete stored ledger, it returns the original receipt with `replayed: true` and `consumedNow: false`; `currentVersion` can reflect later committed transitions. Replay does not extend an approval or grant fresh eligibility. Historical GET and exact receipts remain historical facts after an approval expires. A backwards current wall clock does not invalidate internally consistent history, but a new transition earlier than the latest audit time conflicts.

If transport fails after commit, the durable mutation may already exist. A newly requested retry with the same original request ID and body can resolve the receipt. Do not change the ID to assume the first attempt failed.

## Bounds and refusal behavior

Request JSON is limited to 8192 bytes. Canonical retained input and binding are each limited to 1024 bytes, audit details to 512 bytes, mutation responses including their final newline to 2048 bytes, and owner GET responses to 16384 bytes. Reads validate the complete bounded history, canonical digests and state joins. Corruption refuses without repair or partial projection.

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON |
| 401 | Missing or invalid current personal-token principal |
| 403 | Missing current grants or original-token mismatch |
| 404 | Unavailable owned schedule or new occurrence tuple |
| 409 | Conflicting request, version, state, quota, lease or new-transition clock |
| 413 | Body exceeds its byte limit |
| 415 | Unsupported JSON media type |
| 422 | Invalid DTO or canonical path |
| 503 | Observed native SQLite busy error |
| 500 | Unexpected failure or corrupt stored ledger |

Patrol errors return fixed generic JSON with `Cache-Control: private, no-store`, `Vary: Authorization, Cookie` and `X-Content-Type-Options: nosniff`. SQL, token and internal exception details are not returned. A 500 response is not reclassified as busy based on its text.

This is a finite authenticated review ledger. Scheduled launch, weather policy, docking operations, physical charging, real vehicle identity and runtime handoff remain separate work.
