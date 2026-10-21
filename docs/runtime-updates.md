# Runtime trust and signed image staging

Issue [#9](https://github.com/stacksjs/drone/issues/9) now has offline signed-image
staging, independent candidate verification, protected initial trust enrollment
and a persistent host metadata protocol with protected image preparation. These
commands prepare and verify host state and actual candidate image bytes. Key
revocation/repair, installed images, boot selection and known-good rollback slots
remain part of the full coordinator. Physical deployment is disabled.

## Explicit trust and policy

Enroll an initial TUF `root.json` and its SHA-256 through an independent trusted
channel. Do not calculate a pin from an untrusted bundle and call it trusted.
The release floor must likewise come from externally trusted release policy.
Every staging or candidate-inspection invocation requires the root pin, exact
target, expected bench platform and positive minimum release sequence. There are
no permissive defaults.

```sh
./buddy updates:stage /path/to/offline-repository \
  --trusted-root /path/to/enrolled/root.json \
  --root-sha256 "$ENROLLED_ROOT_SHA256" \
  --target runtime/pico2-bench.bin --platform pico2-neutral-bench-v1 \
  --minimum-release-sequence 7 --output /path/to/new-candidate

./buddy updates:inspect /path/to/new-candidate \
  --root-sha256 "$ENROLLED_ROOT_SHA256" \
  --target runtime/pico2-bench.bin --platform pico2-neutral-bench-v1 \
  --minimum-release-sequence 7
```

The same commands are registered in the [compiled standalone CLI](runtime.md).
Run them as offline maintenance work, separately from a control-loop process.
The implementation requires a POSIX filesystem and bounded regular files.
Parent directories must already exist. An output directory must be new and
separate from the source repository; existing candidates are never overwritten.
Repository/candidate directories must belong to the invoking user and must not
be group/world writable. Their parent paths must also be protected against
replacement by other users. Same-user privileged filesystem mutation is outside
the protection model; this is not an adversarial-filesystem sandbox.

## Protected initial trust enrollment

Store the independently authenticated root and explicit policy in a new private
directory with native Buddy or the compiled CLI:

```sh
./buddy updates:enroll --trusted-root /path/to/enrolled/root.json \
  --root-sha256 "$ENROLLED_ROOT_SHA256" \
  --target runtime/pico2-bench.bin --platform pico2-neutral-bench-v1 \
  --minimum-release-sequence 7 --output /path/to/new-trust

./buddy updates:trust /path/to/new-trust \
  --enrollment-sha256 "$INDEPENDENTLY_RETAINED_ENROLLMENT_SHA256"
```

Retain the returned `enrollmentSha256` through your trusted configuration or
backup channel. Readback requires that independent expected hash; a hash taken
from the same untrusted directory does not establish trust. The record binds a
random enrollment identity, exact root hash/version and copied release policy.
Readback checks the actual root bytes, schema, policy and root self-signatures.

Enrollment creates `root.json` and a final `enrollment.json` record, using an
exclusive 0700 directory and 0600 files. The directory and immediate parent must
be owned and protected from other principals' writes; higher parent paths must
also be protected against replacement. Existing, partial or corrupt enrollments
are preserved and rejected. Files/directories are synced, but the record is a
logical completion marker, not proof of physical power-loss durability. A command
can fail after creating the record, including if output fails. Preserve those
files and independently verify the record before relying on them.

The result reports `metadataState: "initial-root-only"`,
`metadataRefreshPerformed: false`, `firmwareSelectionPerformed: false` and
`physicalDeploymentAllowed: false`. An authenticated expired initial root may be
enrolled for later sequential rotation; this does not make an expired final root
valid for a repository refresh. No refresh or network operation runs here.

Keep this immutable anchor separate from an SDK working cache. The current SDK
writes cache files in place; a host write-limit probe truncated its cached root.
Never refresh against the enrollment directory. Staging/inspection still require
their explicit policy and do not load or advance this enrollment automatically.
The metadata-store functions below retain verified metadata/release floors.
The complete key lifecycle, storage-fault campaigns, image integration and
known-good coordinator remain in [issue #42](https://github.com/stacksjs/drone/issues/42).
Do not discard or re-enroll over failed state to reset a security floor.

## Persistent host metadata protocol

Initialize a separate new private directory and retain its returned `storeSha256`
independently, alongside the enrollment pin:

```sh
./buddy updates:store-init --enrollment /path/to/trust \
  --enrollment-sha256 "$ENROLLMENT_SHA256" --output /path/to/new-store

./buddy updates:store /path/to/new-store --enrollment /path/to/trust \
  --enrollment-sha256 "$ENROLLMENT_SHA256" --store-sha256 "$STORE_SHA256"

./buddy updates:refresh /path/to/new-store --enrollment /path/to/trust \
  --enrollment-sha256 "$ENROLLMENT_SHA256" --store-sha256 "$STORE_SHA256" \
  --repository /path/to/offline-repository \
  --trusted-system-clock-source operator-managed-utc-clock

./buddy updates:recover /path/to/new-store --enrollment /path/to/trust \
  --enrollment-sha256 "$ENROLLMENT_SHA256" --store-sha256 "$STORE_SHA256"
```

Native Buddy and the copied standalone CLI use the same functions under
`resources/functions/drone/updates/store.ts`. The independent store pin binds an
immutable identity to the authenticated enrollment. It is not a hash of the
mutable database or a candidate receipt. Wrong pins, existing initialization
outputs, missing/corrupt files, foreign schemas, unexpected entries, symlinks,
extra hard links and unsafe ownership/permissions fail closed. Existing files
are never recreated as a way to recover a floor. See the
[protocol decision](adr/0028-runtime-trust-store.md).

`writer.sqlite` holds a transaction across awaited work. `state.sqlite` commits
each input and accepted metadata prefix independently while that writer is
excluded. The exact schema, application ID and version are checked before
configuration that could rewrite a foreign database's format. Both connections
require DELETE journals, FULL synchronous commits and configuration readback.
SQLite and directory sync evidence concerns this host, not electrical power loss.

An attempt records its base generation, clock source and fixed start time. Before
the SDK receives an input, its bounded bytes or missing-file response are committed
and read back. The awaited SDK observer commits accepted metadata before its
private cache write. Later verification, compatibility or output failure does not
discard that prefix. Working caches are separate disposable temporary directories.
Progress-callback rejection aborts refresh and preserves its original cause. A
callback's HTTP error cannot stand in for an absent repository file.
`generation` and `retainedMetadataRecords` describe the append-only metadata history;
status lists the active roles and the latest attempt.

The global `releaseFloor` starts with enrolled policy and advances from the selected
compatible target's verified signed declaration. Refresh verifies metadata and
declared compatibility; it does not download or authenticate the actual image
bytes. An attempt marked `verified` means this metadata operation completed. It
does not mean an image is staged, installed, booted or confirmed healthy. Existing
`updates:stage` and `updates:inspect` remain standalone and still report
`trustStatePersisted: false`. The protected `updates:prepare` path below shares
that candidate file format and actual-image readback verification.

Timestamp or snapshot authority rotation, authenticated through sequential root
metadata, creates a new active epoch and invalidates both working-cache entries.
Historical epochs remain in the database. A test changes only the snapshot key,
keeps the timestamp key, accepts metadata counters dropping from 100 to 1 under
the new authority, and still rejects a release below the global release floor.
Changing only the root signing key does not reset active role floors.

### Clock and interrupted attempts

The function interface requires a `RuntimeUpdateClock` with a source label and
`read(): Date`. The adapter must obtain independently trusted current wall time;
there is no repository-supplied time or default adapter. Read once, copy that
instant, and reject a decrease from the persisted clock floor. The native command
uses the system UTC clock only with the explicit source option above. That name
is an audit label, not an attestation that the system clock is synchronized or
protected. Configure and verify that trust externally before invoking it. Trusted
clock acquisition and hardware clock/storage rollback protection remain separate
requirements. Control-loop freshness keeps its own monotonic clock.

A pending or maintenance attempt blocks another refresh. Recovery reconstructs
its exact base cache, replays only durable inputs at the recorded historical time,
and compares every earlier accepted observation with its committed bytes. It can
finish at an owned pre-delivery end-of-recorded-input marker, or after complete
verification followed by a known rejection from our explicit manifest policy.
The latter retains all metadata and the release floor without crediting a rejected
release. Signature, crypto, input-integrity, persistence and unknown SDK errors do
not become permission to discard a journal: they remain maintenance conditions.
No automatic repair for those conditions or corrupt state is supplied yet.
Preserve the directory for investigation.

Recovery can advance floors from a previously journaled valid input that never
reached the SDK before interruption. Its `recovered` status never authorizes an
image; a new trusted-current-time verification is required. Host tests perform
actual SIGKILL cuts after input and metadata commits, observe SQLITE_BUSY from a
competing process, restart and retain the timestamp before a fresh refresh. These
cuts do not cover every write/sync boundary or actual physical power loss.

The v1 format is bounded to 256 attempts, 10,000 metadata advances and a 128 MiB
state database. Each attempt allows 64 inputs, 32 MiB of metadata and 512 KiB per
file. Exhaustion fails closed; history is not automatically deleted or compacted.
Capacity migration, the full storage-fault campaign, authenticated repair/key
revocation, durable slot coordination and session-bound health remain in #42.

## Protected signed-image preparation

Use the pinned store and independently trusted current clock to authenticate an
actual image into a new candidate directory:

```sh
./buddy updates:prepare /path/to/store --enrollment /path/to/trust \
  --enrollment-sha256 "$ENROLLMENT_SHA256" --store-sha256 "$STORE_SHA256" \
  --repository /path/to/offline-repository --output /path/to/new-candidate \
  --trusted-system-clock-source operator-managed-utc-clock
```

The library function is `prepareRuntimeFirmwareUpdate`. Native Buddy and the
compiled CLI use the same function. One writer lease covers metadata verification,
release-floor commit, image verification and candidate output. It uses one SDK
metadata pass with the protected cache and journal. It does not perform a second
unjournaled refresh through the standalone stager.

The signed release floor is committed before reading the image. A bad hash,
missing image or later output failure cannot reopen a release downgrade. The SDK
checks actual payload length and SHA-256 before writing, then checks the actual
written `image.bin` again. The shared candidate file writer emits the same
`stage.json` format as standalone staging only after repository files and image
readback complete. Its file helpers do not grant firmware-selection authority.

The candidate's `trust-root.json` is the currently authenticated protected root,
which can differ from the immutable enrollment root after rotation. Its metadata
archive includes protected active roles, including cached roles that this attempt
did not need to fetch again. Both consistent-snapshot filename modes are supported.
For independent standalone inspection, obtain the current root hash and release
floor from independently pinned store readback, never from a candidate receipt.
The candidate does not need to replay the entire initial root chain: the protected
store has already authenticated that chain and retains its history.

The result schema is `drone-runtime-prepared-image-v1`, with `store` status,
`candidate` declaration, `trustStatePersisted: true` and
`physicalDeploymentAllowed: false`. The nested standalone candidate declaration
still has `trustStatePersisted: false`: that portable receipt is not the protected
store or current authorization. A successful preparation authenticates these
candidate bytes at this operation's trusted time. It does not install, select,
boot or confirm them, and does not promise future trust/expiry policy will allow
selection. Durable candidate ownership, installed/known-good slots and current
policy revalidation before selection remain coordinator work in #42.

Image or candidate-output failure during an attempt leaves accepted metadata and
release floors intact and marks the attempt for maintenance. `updates:recover` replays metadata only; it never
reconstructs image success or confirms an existing candidate. Preserve partial
outputs and use a new output directory for a fresh preparation after recovery.
A complete candidate marker can exist when a later callback or process failure
prevents the operation returning. Marker existence alone is not authorization.
Repository, enrollment and protocol-store directories cannot contain the candidate
output or be contained by it. Existing output directories are not overwritten.

Host tests kill actual competing-writer-excluded processes at `image-written`
and `candidate-completed` progress points. The first follows image-file sync;
the second follows the shared file writer's final marker and directory syncs.
After restart, metadata recovery retains release floor 9 and returns only a store
summary; a fresh preparation uses another new directory. These measured process
cuts do not establish every write/sync boundary, electrical power-loss behavior
or hardware anti-rollback.

## Repository and signed image contract

Use a standard TUF repository with `metadata/` and `targets/` directories,
including consistent-snapshot names when enabled. Verification uses the pinned
[`tuf-js` 6.0.0 client](https://github.com/theupdateframework/tuf-js) for root
rotation, signature thresholds, expiration, inter-role versions/hashes and
target length/hashes. Standalone staging/inspection use a private, randomly
addressed loopback server supplying bounded local files to the public HTTP
interface, then stop it. Protected refresh/preparation use the public Fetcher
interface with bounded local files and the durable input journal. Neither path
provides an external network fetch or arbitrary URL option.
The host additionally verifies that root and delegation key IDs equal SHA-256
of their canonical key objects, using the upstream canonical JSON library.
This rejects arbitrary key-ID aliases before role verification.
Metadata versions must be positive safe integers. Expiration dates must be real
UTC calendar dates in the TUF `YYYY-MM-DDTHH:MM:SSZ` format before the SDK makes
expiry comparisons; malformed or automatically normalized dates are rejected.

### Maintained SDK persistence seam

This repository applies `patches/tuf-js@6.0.0.patch` through Bun's root
`patchedDependencies`. It extends the pinned MIT-licensed client; these are
repository-maintained options, not options supplied by unmodified upstream 6.0.0.
The patch retains upstream signature, role and target verification.

`onVerifiedMetadata(role, bytes)` receives an owned byte copy after the SDK
accepts remote metadata. The SDK awaits it before writing that cache file or
advancing to the next role. A rejected observer aborts refresh, including when
its exception is an HTTP 404. Cache-preferred refresh also propagates persistence
errors instead of retrying past the rejected observer. Initial root loading and
cached metadata do not
emit new observations. An authenticated intermediate root may be observed
before a later final-root expiry check rejects the refresh. Discard an updater
after any refresh failure: its upstream in-memory trust set may already have
advanced. Reusing that instance is not a recovery or persistence retry protocol.

`referenceTime` optionally supplies a finite, copied fixed start time for future
recovery replay. It does not establish a trusted clock. Historical replay must
never authorize firmware use: a coordinator must perform fresh verification at
a trusted current wall time before using a candidate. Existing staging and
inspection pass neither extension and continue to use the current wall clock.

The maintained public exports `MetadataVerificationError`, `PersistError`,
`DownloadError` and `DownloadHTTPError` identify operational failure phases.
Snapshot, targets and persistence wrappers retain the original `Error.cause`.
A caught value is never coerced to build a wrapper message, including a `Symbol`
or an object whose string conversion throws. Persistence rejection must still
abort a cache-preferred refresh in those cases.
A remote metadata verification error includes the role being admitted and its
original cause. Equal timestamp versions keep the normal unchanged-metadata
path. Initial-root and cached-metadata errors retain upstream behavior.

Classify a `PersistError` before examining its cause: an observer can itself
throw a verification error, which is still failed persistence. A verification
phase error alone does not prove that input was invalid, that a prefix is safe
to discard, or that recovery may continue. Unknown crypto, resource or other
causes must fail closed pending investigation. Error objects and type names do
not establish authenticated trust or permit firmware use. The recovery
coordinator's broader failure classification and authenticated maintenance repair
remain to be implemented. The metadata protocol above only recognizes its own
pre-delivery replay marker and completed domain-policy rejection.

The seam alone does not persist a protected prefix or make SDK cache writes
transactional. Its implementation and tests are a prerequisite for the protected
store and recovery coordinator in issue #42. The bounded metadata protocol above
uses that seam; neither completes the full coordinator or
permit flashing, boot selection or physical deployment.

The selected target must have SHA-256, a nonzero length of at most 16 MiB and
exactly these fields in its signed `custom.drone` object:

```json
{
  "schema": "drone-runtime-image-v1",
  "platform": "pico2-neutral-bench-v1",
  "protocolVersion": 1,
  "releaseSequence": 7,
  "sourceRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "profile": "neutral-bench"
}
```

The other supported platform label is `host-neutral-bench-v1`. Target and metadata
paths use bounded ASCII names without traversal, escapes or symlinks. Metadata
is limited to 512 KiB per file, 16 root rotations, 16 delegations, 64 requests and
32 MiB of distinct fetched bytes. FIFO, device, symlink and oversized inputs fail.
The neutral profile is a **signer's declaration**, not an inspection of machine
code or proof of neutral outputs. This module authenticates bytes and declared
compatibility; it does not parse UF2/ELF or execute an image.

## Candidate integrity and interruption

The private candidate contains the original `trust-root.json`, verified
`image.bin`, fetched repository files, SDK metadata cache and final `stage.json`.
The image is verified again after copying. Files/directories are synced and the
completion marker is written last. Failures propagate and leave evidence in the
new directory. A partial directory without a valid marker fails inspection.
Do not reuse or automatically resume that directory.

Inspection starts a fresh verifier with the independently supplied root pin and
policy. It verifies the saved repository's signed metadata and actual image
again, then compares the receipt with authenticated values. It does not trust
the receipt's claimed hash, platform, release or authority. A raised release
floor can reject a previously accepted candidate. Inspection does not modify
the candidate.

The marker means logical completeness. It cannot prove that a final sync or
subsequent power loss preserved bytes. A process can fail after the marker was
written. Inspection must always re-authenticate the candidate; no consumer may
treat marker existence alone as permission to install or boot it.

## Remaining update and operations acceptance

The separate image-stage/inspection path still starts from its supplied root.
Its `trustStatePersisted: false` result means it does not use the metadata store's
cross-invocation floors. The caller must supply its trusted release floor each
time. Neither path is a complete anti-rollback coordinator. Trusted clock
acquisition and protection against privileged clock/storage rollback remain
open. Control-loop freshness still uses its separate monotonic clock.

Initial enrollment, the bounded persistent metadata protocol and protected
signed-image preparation are available above. Complete authenticated
maintenance/key revocation and the full storage-fault campaign, then durable
candidate ownership, installed/known-good slot integrity, explicit health
confirmation and rollback without lowering security floors. Then add
the board bootloader/install protocol and measured power-loss, full-medium,
storage-latency and recovery campaigns. Local privileged filesystem tampering
is outside this host module's protection; it is not secure boot or hardware
anti-rollback. See [TUF's workflow and threat model](https://theupdateframework.github.io/specification/latest/).

Tests use generated throwaway Ed25519 keys and clearly synthetic payload bytes.
They cover real role signatures/rotation, expiration, compatibility, supplied
release floors, tampering, bounded inputs, incomplete candidates, enrollment
readback, competing enrollment processes, an actual host write-limit failure and
native/portable CLI behavior. They establish host behavior, not actual firmware
installation, board boot recovery or commissioning. The diagnostic supervisor's
update/rollback check remains blocked and `commissioningReady` stays false.
