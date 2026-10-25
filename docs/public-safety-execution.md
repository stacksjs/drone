# Synthetic incident execution

The source Stacks application supports owned synthetic execution and deliberate
source admission. See [ADR26](adr/0026-owner-bound-incident-execution.md) for its
authority and deployment contract.

The `/incidents` workspace runs the existing owned public-safety simulator with
an explicit scenario and requested virtual duration of 8 to 120 seconds. Connect
an existing native personal credential with current read and coordinate access,
incident membership and source-registration permission. Read-only users retain
the ordinary workspace view with execution controls disabled.

## Run, stop and admit

1. Choose the scenario and requested duration, then select **Start synthetic run**.
   Progress comes from actual producer callbacks. Requested duration and actual
   virtual time are separate; the survey may finish before its requested budget.
2. **Stop synthetic run** ends future progress and requests cooperative producer
   cancellation. A finished acknowledgement means owned producer work ended.
   An unconfirmed stop keeps the reservation occupied.
3. Completion retains a temporary checked recording and its digest. It writes no
   durable source. **Discard temporary result** releases a finished reservation.
4. **Admit completed source** deliberately uses the existing source writer, current
   incident version and completed digest. Admission refreshes the source catalog;
   it does not select the new imagery or acknowledge a handover.

Changing scenario, duration or an observation draft while an earlier request is
pending does not change that accepted run. Later responses preserve newer drafts.
Identity changes, scope replacement and access refusal clear private content.
Credentials remain in volatile request closures and Authorization headers.

The run is synthetic and physical outputs remain inhibited. Its event counts,
routes and thermal values do not establish searched area, absence of people or
fire, or measured sensor performance.

## API

Paths below share `/api/public-safety/incidents/{incident}/workspace`.
Every operation independently checks native Auth, Gates and current SQL policy.
IDs and scope markers are preconditions, not access credentials.

| Method and suffix | Input | Result |
| --- | --- | --- |
| `POST /execution` | `{intent, scope, scenario, seconds}` | `202` execution view |
| `GET /execution?scope=...` | One scope query | Current original-owner view or `null` |
| `GET /execution/{execution}/events?scope=...` | One scope query | Native SSE progress for existing work |
| `POST /execution/close` | `{execution, scope}` | Stop request or finished discard |
| `POST /execution/admission` | `{execution, scope, digest, expectedVersion}` | `201` existing source-registration result |

POST bodies are strict UTF-8 JSON, capped at 8,192 bytes. Unknown fields and
decoded duplicate keys are refused. GET and HEAD reject body framing. HEAD
performs the current read without starting a producer or attaching a subscriber.
Responses use private, no-store headers. Progress includes bounded status,
the latest genuine event and completion metadata, without recording arrays,
imagery, private controls or account identifiers.

One process retains one execution reservation and one subscriber. A retained
reservation conflicts with another start: `409` for the original token and `429`
for a different eligible token. Another token for the same account cannot adopt
the original work. Original membership generation, incident incarnation, full
configuration, purpose and retention remain bound throughout.

## Reconnect and uncertain outcomes

Progress reconnects attach to the same existing execution. A GET never executes
the POST again. Native successful enqueue grants local producer credit; it does
not establish remote receipt. Connected and heartbeat frames cannot grant an
application credit. Native queue overflow or closure releases the subscriber;
current authority is checked again before opaque bytes leave the adapter.

An ambiguous start is reconciled with current status. The client does not blindly
retry it. A duplicate conflicts only while its reservation remains. Process loss,
expiry or discard can return `null`, which says nothing about historical work.

Admission is single flight. Close cannot undo a submitting or committed write.
If a response is withheld after actual COMMIT, admission is marked unknown.
A fresh authorized source-catalog read can establish whether the digest exists,
without identifying which racing request inserted it. Do not retry blindly.

## Lifetime and deployment

The default wall lifetime is 60 seconds, stream renewal is 30 seconds, and
attach/reconnect grace is 10 seconds. Native checks have a two-second budget;
timed-out underlying SQL remains charged until it actually settles. The native
queue holds two frames, each capped at 4,096 bytes. Completed or canceled metadata
expires after 60 seconds. Original credential and incident deadlines cap these
lifetimes. Unconfirmed termination remains quarantined after ordinary expiry.

Full canonical validation and replay stay enabled, with a 16 MiB recording cap.
These are finite software admission rules, not hard CPU, memory or scheduling
bounds. Worker completion does not establish an individual OS thread join.

The initial deployment target is the source Stacks app with a file-based Worker.
The installed Stacks 0.75.301 realtime package provides the public
`@stacksjs/realtime/stream` enqueue and close observers. The copied Action also
passes a fresh-process module-loading and stream-lifecycle qualification, with
source fallback denied. See [dependency source releases](dependency-source-releases.md).
Complete authenticated bundled-server, Docker and physical Pi deployment need
separate qualification.

The tracer adds no durable run model, job queue, filesystem recording, derivative
cache or accepted purge inventory item. Process loss ends volatile work. Sector
and team responsibility, operational acceptance and hardware qualification remain
separate [issue #23](https://github.com/stacksjs/drone/issues/23) work.

## Verification

The required `execution-browser` CI job sets `EXECUTION_BROWSER_QA=true` and runs
the rendered STX fixture with real native accounts, SQLite and the production
Worker. The fixture covers progress before producer return, GET renewal without
a second start, stop/discard, completion without source creation, deliberate
admission, retained drafts, read-only controls, revocation and mobile overflow.
Its passing result is required; an ordinary-suite skip does not qualify it.

```sh
EXECUTION_BROWSER_QA=true BROWSE_BROWSER=/path/to/google-chrome bun test tests/unit/public-safety-execution-browser.test.ts
```

Native controller and HTTP checks separately cover authority replacement,
elapsed deadlines, stream capacity, cleanup and durable COMMIT with a withheld
response. The existing workspace browser scenarios remain required regressions.

### HTTP fixture failure observations

The native HTTP fixture records parent and child Bun identity separately, bounded
phase timings and the actual settled exit code and signal. Parent and child
elapsed times have separate local monotonic origins. The original 35,000 ms
SIGKILL guard and 40,000 ms test limit remain unchanged.

To collect a focused observation in an operator-controlled private directory:

```sh
EXECUTION_HTTP_EVIDENCE="$HOME/private-drone-http-evidence" bun test tests/unit/public-safety-execution-http-limits.test.ts --test-name-pattern 'native execution HTTP limits nativeRoutes=true'
```

Successful, fully captured fixtures are removed. A failed fixture or unavailable
evidence write retains its directory, including available `fixture.stdout`,
`fixture.stderr` and `lifecycle.json`. Failed fixture databases contain generated
test credentials and remain private. Evidence write failures are reported without
replacing the child's settled result.

`watchdogFired` records that the parent's guard callback ran; `watchdogKill`
records its SIGKILL request. `cleanupKill` records a separate cleanup request.
The actual child signal and settled status are independent observations. Exit 137
alone does not identify the kill actor. A missing child runtime record remains
unknown, including when termination precedes entry-module evaluation.

These observations support the [open HTTP timeout investigation](https://github.com/stacksjs/drone/issues/93).
They do not establish its original cause or turn a later passing control into a
fix for an earlier failed run.
