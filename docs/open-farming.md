# Open Farming integration

Open Farming advertises 19 farming capabilities. Their implementation work is tracked in the
[Open Farming roadmap](https://github.com/theopenfarm/openfarm.ing/issues/2). A catalog entry,
scheduled database row or modeled demonstration does not establish a completed flight or an
agronomic result.

The first shared boundary is `planFarmingObservation`, a versioned planning preview over the
existing owned agriculture planner. It validates an explicit metric declaration and returns the
complete planned route, calibration declarations, parcels and estimates. It performs no camera
collection, mission execution or aircraft dispatch. ArduPilot and PX4 remain optional drivers.

## Run an explicit preview

From this application:

```sh
./buddy farming:plan examples/farming-plan.json
```

The standalone CLI exposes the same command:

```sh
drone farming:plan /operator/requests/field-plan.json
```

The request file is mandatory. There is no default field, scenario or configuration. The committed
example is a fictional 1.6 m square with synthetic camera and red/NIR calibration declarations,
not the coordinates of an actual farm. Its farm and field identifiers are unverified correlations.

The native Stacks command reads a bounded regular file, refuses a final symlink, decodes strict
UTF8 and awaits the complete output write. Parent directories are followed. Local file reading
does not establish path authorization or an atomic snapshot of a concurrently changing file.

Accept output only after exit 0 and complete bounded stdout/stderr through EOF. Success is one
compact JSON document plus a final LF, with empty stderr. A handler failure exits 1 and attempts
one fixed diagnostic:

```text
Farming planning preview unavailable: invalid declaration, rejected plan or output failure
```

A failed stdout write can leave a partial prefix. A failed stderr pipe can prevent delivery of
the diagnostic; the handler retains exit 1. Native CLI help and argument errors retain the CLI's
existing behavior.

## Library contract

The pure browser-compatible function lives in
`resources/functions/drone/agriculture/farming-plan.ts` and is exported from the drone barrel:

```ts
import { planFarmingObservation } from './resources/functions/drone'

const preview = await planFarmingObservation(requestJson)
```

The argument is a primitive JSON string. Use `examples/farming-plan.json` as a complete explicit
wire example. Every top-level field is required:

| Field | Meaning |
|---|---|
| `version` | Exactly `1` |
| `operation` | Exactly `agriculture-observation-plan` |
| `requestId` | Declared request correlation |
| `context` | Positive safe-integer `farmId` and `fieldId`, plus `declarationId` |
| `geometry` | Explicit frame, units, datum, declaration evidence and source reference |
| `config` | Complete existing `AgricultureConfig`, including survey, parcels and radiometry |

The request, context and geometry records reject extra fields. The three declared reference IDs
match `^[a-z][a-z0-9-]{0,63}$`. Geometry requires `LOCAL_NED`, horizontal metres,
`WGS84_ELLIPSOID`, `operator-declared-metric` and an explicit `sourceReference`. Down is positive.
The source reference is a declaration label; it is not a path or URL that the library fetches.

Open Farming's normalized display boundary, centroid and hectares cannot supply this metric
declaration by themselves. The app needs a checked transformation, heading, terrain and datum
before it can relate a planning preview to its field overlay. This function performs no transform
and verifies no ownership or surveyed accuracy.

Nested admission uses the actual agriculture and survey planners. Their calibration, geometry,
parcel, grid, route and endurance limits remain in force. No lane truncation, field shrinking or
implicit calibration supplies missing inputs. AOI holes exclude imaging transects; route
connectors can cross holes, and footprints can extend beyond the AOI. A hole is not a no-fly
boundary.

The returned document has `kind: farming-observation-planning-preview` and `status: planned`.
It retains the complete owned `AgriculturePlan` and these explicit flags:

```json
{
  "ownershipVerified": false,
  "geometryVerified": false,
  "physicalFlightEnabled": false,
  "observationPerformed": false,
  "dispatchPerformed": false
}
```

Area, GSD, photo count, distance, time and energy are estimates conditioned on the supplied
declarations. The preview contains no captured imagery, observed coverage, NDVI layer, disease
diagnosis, actual expenditure or completed mission. Declared calibration epochs and timing
limits are retained. The preview generates no new acquisition or wall-clock timestamp.

## Identity, bounds and failures

`source.sha256` hashes the exact accepted original UTF8 request bytes, including whitespace.
`source.byteLength` records their length. Native JSON last-key-wins semantics apply before closed
validation. Equivalent declarations with different byte representations can have different
hashes. This request digest is not a separate canonical-config hash, an authenticated source,
tenant verification or proof of the deployed executable's identity.

Each call owns its returned state. Admission, planning and complete finite ordinary-data result
checks happen before the asynchronous Web Crypto digest. The module opens no file, socket,
database, worker or hardware transport and takes no caller-supplied hasher.

The request ceiling is 262,144 UTF16 code units and 262,144 UTF8 bytes, checked before parsing.
Raw ill-formed UTF16 and a BOM are refused. Escaped JSON strings follow native JSON semantics
and the nested validators. The complete compact result plus one LF is limited to 524,288 UTF8
bytes. Overflow is refused rather than shortened. These are transport limits, not measured
memory, flight-duration or farm-size guarantees.

| Error | Meaning |
|---|---|
| `TypeError('farming-plan-input')` | Invalid primitive, Unicode, JSON or closed declaration |
| `RangeError('farming-plan-limit')` | Request or complete result exceeds the transport ceiling |
| `Error('farming-plan-rejected')` | The existing planner rejects the nested configuration |
| `Error('farming-plan-unavailable')` | Required encoding, digest or result delivery is unavailable |

The pure boundary exposes fixed errors without caller values or underlying stacks. It checks
primitive/length, Unicode/encoded length, JSON/envelope, planner and complete result before
digest availability/completion.

## Retain a synthetic collection

Collection is a separate operation over the existing owned sensor, estimator, mission,
authority and camera simulation. It does not turn the planning estimates into measurements.
Both native Buddy and the standalone CLI require an explicit collection request and a new
output directory:

```sh
./buddy farming:collect examples/farming-collection.json /operator/attempts/new-collection
drone farming:collect /operator/requests/collection.json /operator/attempts/new-collection
```

The parent directory must already exist and be operator controlled. The command refuses an
existing final directory, file or symlink. The request cannot choose an executable, provider,
clock or output path. The example retains the planning example's complete fictional metric
configuration, with an explicit synthetic visit, nominal scenario and 100-second duration.

The server-side library function is deliberately outside the browser-pure barrel:

```ts
import { collectFarmingObservation } from './resources/functions/drone/agriculture/farming-collection'

const delivery = await collectFarmingObservation(requestJson, operatorProvisionedDirectory)
```

Every declaration field remains required. The operation is exactly
`agriculture-synthetic-collection`, with an additional closed `simulation` record containing
`visitId`, `scenario` and integer `seconds` from 8 through 120. Supported scenarios are
`nominal`, `irradiance-loss`, `band-skew`, `saturation`, `camera-loss`, `wrong-ack`,
`position-loss`, `rc-override` and `abort`. There is no scenario-based success override.
The visit label uses the same bounded ASCII identifier rule as the request references.
The full configuration must also pass the owned executable mission's calibration, clock,
pixel, fence and task limits. A planning-only accepted declaration may not be executable.

The function validates the actual run, serializes and reparses its complete raw recording,
recomputes the entire calibrated layer and reuses `writeAgricultureDataset`. It reads back
the exact recording, layer and completion marker before publishing a separate attempt:

```text
new-collection/
  dataset/                 Existing raw visible/red-NIR/calibration/layer exporter
    manifest.json          Raw dataset completion marker
  attempt/
    request.json           Exact original UTF8 declaration bytes
    producer.json          Limited software content observations
    result.json            Complete source-bound collection record
    dataset-manifest.json  Exact copy of the raw dataset marker
    manifest.json          Attempt completion marker, published last
```

The returned `farming-synthetic-collection-delivery` includes the complete record and the
attempt marker's relative path, byte count and SHA256. The record binds the original request,
declared context/geometry, producer document, actual raw recording and dataset marker. It
retains every layer cell, parcel summary, source pixel, null, mask and conditional uncertainty
interval. It creates no operational Mission, Detection, TreatmentMap or HerdMove.

Software observations distinguish source and standalone hosts. Source execution observes the
named 56-file `farming-collection-source-v1` profile plus the actual Bun executable. Standalone
execution observes the actual compiled executable. These are unsigned file-content identities,
with `authenticatedExecution: false` and `loadedGraphAttested: false`. Source profiles exclude
bare packages, builtins, preloads and unrelated host imports; a standalone host can also load
external code. Neither method proves a complete executed-code graph or authenticates a camera,
principal, field or unique event. Paths and executable selection come from the owned module
and host, not request fields.

`observationsUnchanged` compares observations before collection and after dataset read-back.
Its explicit `observationInterval` excludes later attempt publication and stdout delivery.
Equality does not prove continuous immutability or absence of transient changes.

Exit 0 requires a completely delivered, persisted synthetic run whose actual status is
`completed`, with a neutral modeled board and replay-consistent terminal mission snapshot.
Exit 2 delivers retained neutral `aborted`, `blocked` or `incomplete` evidence. An incomplete
snapshot keeps its actual ready/running/paused state and target; board revocation is not a
controlled landing. A short or zero-capture run still retains its full missing-data layer.
None of these outcomes establishes physical flight, field calibration, agronomic validity,
ownership, dispatch or operational mission completion.

Handler failures exit 1 and attempt this fixed diagnostic, consuming a secondary error-pipe
failure:

```text
Farming collection preview unavailable: invalid declaration, rejected collection or output failure
```

Accept a delivery only after complete bounded streams through EOF and its actual exit code.
A broken output pipe can leave a prefix after completed artifacts exist. Partial roots and
completed artifacts are preserved on failure. A post-link filesystem sync failure can leave
a visible marker while the operation reports failure; marker existence alone is not returned
success, stdout delivery, authenticated storage or tested power-loss durability.

Collection keeps the 262,144-unit/byte request ceiling. Its complete compact record plus LF
is limited to 16,776,192 UTF8 bytes; delivery plus LF to 16,777,216 bytes; producer JSON plus
LF to 131,072 bytes; the attempt marker to 16,384 bytes. Named source content is bounded to
256 files and 8 MiB in aggregate; the internally selected executable is hashed in bounded
chunks up to 256 MiB. Existing 64-capture, 65,536-pixel, raw recording, metadata, grid,
runtime and exporter ceilings remain unchanged. Repeated validation and encoding allocate
additional memory; transport limits are not peak-memory or Raspberry Pi performance proof.

Library errors are fixed `farming-collection-input` (TypeError),
`farming-collection-limit` (RangeError), `farming-collection-rejected` (Error for executable
configuration rejection) and `farming-collection-unavailable` (Error for host, collection,
identity or persistence failure). No caller values or native filesystem errors are exposed.

## Remaining integration work

[Drone issue 37](https://github.com/stacksjs/drone/issues/37) tracks this planning boundary.
[Issue 38](https://github.com/stacksjs/drone/issues/38) tracks the source-bound synthetic
collection boundary described above, using the existing dataset writer and calibrated processing. Neither establishes
physical camera calibration, a field deployment or a validated agronomic model.

[Open Farming issue 3](https://github.com/theopenfarm/openfarm.ing/issues/3) tracks the authenticated
app adapter to an operator-provisioned, pinned standalone CLI. It must verify the principal's farm
and field before launching, recheck delayed reads/completions, bound and reap the child, and keep
private attempts and source/executable identities. Remote users must not supply executable paths
or command arguments. Its genuine matching Stacks runtime and route/auth/database tests are
separate qualification gates. Planning previews must not write operational mission completion,
detection, treatment or herding outcomes.

Private sources, processing attempts and machine formats have their own foundation issues.
The capability tickets cover distinct normal, loss and completion behavior:

| Capability | Open Farming issue |
|---|---|
| Field mapping | [6](https://github.com/theopenfarm/openfarm.ing/issues/6) |
| Drone service | [7](https://github.com/theopenfarm/openfarm.ing/issues/7) |
| Plant disease detection | [8](https://github.com/theopenfarm/openfarm.ing/issues/8) |
| Pest monitoring | [9](https://github.com/theopenfarm/openfarm.ing/issues/9) |
| Yield forecasting | [10](https://github.com/theopenfarm/openfarm.ing/issues/10) |
| Wildlife rescue | [11](https://github.com/theopenfarm/openfarm.ing/issues/11) |
| Livestock and fences | [12](https://github.com/theopenfarm/openfarm.ing/issues/12) |
| Targeted weed control | [13](https://github.com/theopenfarm/openfarm.ing/issues/13) |
| Precision fertilisation | [14](https://github.com/theopenfarm/openfarm.ing/issues/14) |
| Soil compaction | [15](https://github.com/theopenfarm/openfarm.ing/issues/15) |
| Drone seeding | [16](https://github.com/theopenfarm/openfarm.ing/issues/16) |
| Automated herding | [17](https://github.com/theopenfarm/openfarm.ing/issues/17) |
| Irrigation analysis | [18](https://github.com/theopenfarm/openfarm.ing/issues/18) |
| Frost protection | [19](https://github.com/theopenfarm/openfarm.ing/issues/19) |
| Pollination support | [20](https://github.com/theopenfarm/openfarm.ing/issues/20) |
| Autonomous network | [21](https://github.com/theopenfarm/openfarm.ing/issues/21) |
| Bird deterrence | [22](https://github.com/theopenfarm/openfarm.ing/issues/22) |
| Sustainability dashboard | [23](https://github.com/theopenfarm/openfarm.ing/issues/23) |
| Field assistant | [24](https://github.com/theopenfarm/openfarm.ing/issues/24) |

[Marketing and docs issue 25](https://github.com/theopenfarm/openfarm.ing/issues/25) tracks catalog
counts, missing herding translations and flight-stack guidance. Marketing copy and simulator
outputs do not close the hardware, field-validation or application-integration gates.
