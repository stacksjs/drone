# Incident source evidence, observations and review

The incident record functions retain verified owned collection sources, explicit operator pixel
declarations and append-only review history. Native Stacks accounts, tokens, permissions, Gates,
model-derived migrations and transactions provide the persistence and access checks described in
[incident access](https://github.com/stacksjs/drone/blob/main/docs/public-safety-access.md). The collection producer remains unsigned simulation.

[Managed source datasets](https://github.com/stacksjs/drone/blob/main/docs/public-safety-managed.md) can explicitly publish private derivatives
from one admitted source after custody enrollment, without copying observation or review notes.

## Register a collection source

Create an incident through the access API, then collect with that exact configuration through
`buddy public-safety:simulate --config <path> --output <new-directory>`. Use a server retention
deadline within the access API's permitted window. The default offline fixture is a separate
declaration; changing only the incident's deadline or visit does not make an earlier recording
match it. Registration receives the parsed `recording.json` as `recording`, with the last observed
incident version as `expectedVersion`.

The server validates the complete recording by re-executing its pinned owned profile and compares
the complete canonical configuration with the locked incident. It computes SHA-256 over canonical
UTF-8 JSON without a trailing newline. The source digest, byte length, uploader account, upload time
and accepted incident sequence are server-owned. Accepted recordings remain immutable. Registering
the same digest again returns 409 without another version or audit event.

Verified partial or fault recordings can be retained, including a source with no confirmed capture.
Only actual confirmed captures can support a pixel observation. Source metadata lists omit the
recording planes. Reading a source returns `{ source, recording }`, where `recording` is plain JSON
with numeric image arrays, so its canonical digest can be reproduced without typed-array object
serialization.

`uploaderAuthenticated: true` describes the native requesting account. The separate
`sourceIdentityAuthenticated: false`, `physicalThermalVerified: false` and
`physicalFlightEnabled: false` remain explicit. Uploading a recording does not authenticate its
producer, qualify a thermal measurement, establish lawful authority or enable vehicle outputs.

## Roles and native routes

Every operation requires current native token/platform eligibility, active incident membership
and server retention access. Reads require `public-safety:read`; writes require
`public-safety:coordinate` in addition to the role below. A token scope alone grants no role.

| Operation | Permitted incident roles |
| --- | --- |
| Read sources, observations and reviews | Every active member |
| Register a source | Current coordinator, pilot, evidence custodian |
| Append an explicit observation | Every active member |
| Append a review | Current coordinator, reviewer |

The existing coordinator and audit rules remain in effect. A custodian's upload duty does not
grant review duty. Closed incidents permit reads until expiry and reject further record appends.
Expiry denies private record access, including when the config declares a hold requiring review.

All routes below are relative to `/api/public-safety/incidents/{incident}`:

| Method | Path | Exact body or query |
| --- | --- | --- |
| POST | `/sources` | `{ expectedVersion, recording }` |
| GET | `/sources` | Optional `after`, `limit` |
| GET | `/sources/{digest}` | No query |
| POST | `/observations` | `{ expectedVersion, sourceDigest, captureId, modality, pixel: { x, y }, note, uncertaintyNote }` |
| GET | `/observations` | Optional `after`, `limit` |
| GET | `/observations/{observation}` | No query |
| POST | `/observations/{observation}/reviews` | `{ expectedVersion, sourceDigest, previousReviewId, disposition, note }` |
| GET | `/observations/{observation}/reviews` | Optional `after`, `limit` |

Mutations return 201 with `{ incident, source }`, `{ incident, observation }` or
`{ incident, review }`. Use that incident's new version for the next mutation. Source digests are
64 lowercase hexadecimal characters. Observation and previous-review IDs are native positive
integer IDs, always resolved through the current incident's immutable source chain. A foreign
record is unavailable even when the caller belongs to both incidents.

Lists return `{ entries, cursor, hasMore }`, defaulting to 100 entries with a maximum of 100.
Pass `cursor` as the next `after`. Sequence values are shared across every accepted incident
mutation, so lists can have gaps. They are not array positions or row IDs. Each page rechecks
access and contains only its requested record type.

## Explicit source-pixel observations

`modality` is `visible` or `thermal`. Pixel coordinates are integers in the confirmed image,
starting at its top-left corner. The original row-major support must equal 1, observed synthetic
ground. Unobserved support 0 and privacy-masked support 2 are refused. Thermal also requires an
available original numeric sample. A black visible pixel alone neither proves nor refutes support.
An unmatched shutter ACK, planned capture or similarly named file is not a confirmed source.

The private note is an explicit operator declaration. The required uncertainty note remains
alongside it; neither changes the source pose, timing, calibration or qualification. Notes are
preserved as authored, with nonempty UTF-8 limits of 2,048 bytes for `note` and 1,024 bytes for
`uncertaintyNote`. Actor identity and submission time come from the server. There is no inferred
person identity, automatic detection, pixel-to-person geolocation or autonomous enforcement.

## Append-only operator review

Review dispositions are `unresolved`, `supported-by-source` and `not-supported-by-source`.
These are reviewer declarations about the retained source. They do not certify a person, fire,
medical diagnosis, physical radiometry or legal purpose. The original observation and its
uncertainty remain intact.

The first review supplies `previousReviewId: null`. Later reviews must name the current latest
review ID for that observation and its exact source digest. A stale latest pointer returns 409;
a pointer to another observation is unavailable. Appending a review never edits an earlier row,
replaces the observation or removes unresolved history. Self-review is permitted for an account
with review duty and is exposed as `selfReview: true`; it provides no independent verification.

Each accepted source, observation or review advances the incident version once and appends one
audit event in the same native transaction. Competing same-version mutations have one winner.
An audit insertion failure rolls back the record and version together. Fresh authorization and
the referenced source are checked inside the mutation transaction after source prevalidation.

## Wire limits and remaining work

Canonical source data is limited to 16 MiB. Its HTTP envelope is limited to 16 MiB plus 4,096
bytes; observation and review bodies to 8 KiB. Authorization runs before bounded body reads,
and native cookie CSRF remains enabled. Unknown fields, unsupported queries, duplicate cursors
and noncanonical numeric identifiers are refused. Responses and errors remain private and
uncacheable. These models have no generated REST, search or generic dashboard exposure.

The access deadline controls current reads and writes. It does not erase database pages, exported
files, backups or uncontrolled copies. [Retention custody](https://github.com/stacksjs/drone/blob/main/docs/public-safety-retention.md) provides explicit enrollment and hold review,
without granting deletion authority. [Accepted local purge](https://github.com/stacksjs/drone/blob/main/docs/public-safety-purge.md) separately
controls active DB payload and registered files; uncontrolled copies remain excluded. The
[incident handover module](https://github.com/stacksjs/drone/blob/main/docs/public-safety-handover.md) binds recipient acknowledgement to a
selected-source briefing and its original uncertainty. Sector/team assignments, an authorized
operator workspace and live observations remain in issue #23,
alongside hardware, jurisdiction/operator, interoperability and field qualification.
