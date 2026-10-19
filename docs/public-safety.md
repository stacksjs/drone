# Owned public-safety collection

Issue [#23](https://github.com/stacksjs/drone/issues/23) requires coordinated search, fire and disaster observation, incident annotations, operator review, team handover, enforced access/privacy/retention and runtime handling of communications, incident boundaries and resources. This is the collection and runtime foundation. Annotations, authenticated coordination, retention deletion and handover remain required work.

The four explicit observation purposes are search and rescue, fire observation, disaster assessment and lawful police observation. There is no identity recognition, automatic person pursuit, detention or enforcement action. Purpose authority and retention are explicit declarations, not established legal authority. All fixtures are synthetic and physical outputs remain inhibited.

## Collection contract

The configuration selects one bounded sector for the existing owned quad survey mission. Other sectors remain unsearched. The planner validates simple polygon boundaries, all straight transit segments including takeoff/return, calibration, the existing mission task/time limits and power budget. The operating boundary differs from the search sector and no-observe zones.

The actual raw sensor, estimator, supervisor, controller, modeled independent board and rigid-body loop execute the survey. A scoped session binds incident, accepted revision and visit in the actual shutter requests and ACKs. Numeric thermal counts and visible RGBA are rendered at the capture epoch, retained by the same acknowledged shutter transaction and joined by session, sequence, reference and exact timestamps. Rendering truth supplies pixels; estimated pose supplies geotags and admission.

Thermal fields are synthetic centikelvin values. They are independent of visible colors and do not identify people, diagnose injuries, measure a real fire perimeter, establish physical radiometry or declare a structure safe. Per-pixel support is explicit: 0 unobserved, 1 observed synthetic ground, 2 privacy masked. A masked pixel is opaque black and has unavailable thermal value zero. Truth-ray no-observe masking happens before shutter storage. This only establishes the synthetic fixture's masking behavior; real pose/registration/uncertainty masking remains unqualified.

Events are emitted synchronously during virtual execution. They expose already observed epochs and confirmed capture identities. They are live within the simulation producer, not an external or wall-clock incident feed. Mutating a consumer event cannot alter the retained run. Consumer exceptions abort the producer, revoke modeled output and prevent publication of a successful recording.

## Incident changes and loss

Native mission instrumentation now accepts qualified per-epoch link and battery samples before supervisor and mission decisions. Supplied battery cannot exceed nominal modeled resources. Missing updates preserve the original timestamp and expire; omissions cannot silently restore resources or refresh link freshness. Invalid, future, stale, regressing or conflicting observations fail closed. Default mission/survey behavior is preserved.

Public-safety loss scenarios are anchored to actual confirmed collection where applicable. Link loss/staleness and battery depletion reach the real authority/mission loop. Incident boundary or endurance revisions invalidate the accepted plan and release targets. They retain the old graph, time/energy accounting and revision record, require a new pilot acceptance, and never silently start a replacement mission. A declared 3-sigma position margin also gates the operating boundary. These are fixture uncertainty assumptions, not measured physical containment.

An abort or authority loss releases targets and sets modeled thrust to zero. This is not a real emergency landing procedure. Physical lost-link/landing behavior requires its own reviewed implementation and measured validation.

## Native Stacks commands

```sh
./buddy public-safety:plan examples/public-safety.json
./buddy public-safety:simulate --output /tmp/incident-collected
./buddy public-safety:simulate --purpose fire-observation
./buddy public-safety:simulate --scenario link-loss
./buddy public-safety:simulate --scenario boundary-change
./buddy public-safety:replay /tmp/incident-collected/recording.json --at-ms 600
```

The standalone `drone` binary provides the same commands outside the checkout. `--seconds` is an integer from 8 through 120. A truncated run cannot count as a successfully demonstrated fault. Invalid replay epochs fail rather than rounding to another observation.

The private exclusive dataset contains the complete recording, actual PNG pixels, row-major uint16 little-endian thermal fields, uint8 support masks and a final completion manifest with exact byte counts and SHA-256 hashes. Files and directory entries are synced before the completion marker is published. A preexisting destination is rejected. Caller-owned data is snapshotted before asynchronous encoding. This is unsigned content consistency, not confidentiality, authenticated custody or tested hardware power-loss durability.

Replay re-executes the pinned `owned-public-safety-collection-v1` deterministic owned sensor/physics/shutter/incident profile and compares all retained data. This intentionally requires the matching software profile. It does not authenticate a producer or replay external physical sensors. Source and output bounds are 16 MiB and 32 MiB respectively.

## Remaining full issue scope

- Source-bound explicit incident annotations and append-only operator review, retaining uncertain and missing observations.
- Native authenticated incident membership/roles on every read, write, export and live event path. Declared offline actor strings are insufficient.
- Enforced purpose, retention/hold policy, expiry, revocation, redacted views and removal of controlled evidence copies. Offline files currently do not enforce deletion.
- Recipient-, assignment-, source- and expiry-bound two-phase handover with atomic acceptance and audit. Incident responsibility and vehicle control remain separate.
- A shared operator workspace with actual authorized live event delivery, partial searched/unsearched support and reviewed observation/handover actions.
- Measured visible/thermal calibration, timing/heading/georeferencing, communications, legal/jurisdiction/operator qualification, real team operations, external firmware integration and bench/HIL/vehicle campaigns.

All three issue acceptance requirements remain open until their complete software workflow is verified. Full operational and physical acceptance remains separate from synthetic evidence.

## Authenticated coordination

The persisted [incident access API](public-safety-access.md) uses native Stacks accounts, tokens,
permissions, Gates and generated models for scoped incident membership, closure and paginated
audit. Collection artifacts keep their separate unsigned simulator evidence boundary. Annotations,
review, managed erasure, atomic handover and the operator workspace remain part of issue #23.
