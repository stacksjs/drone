# Runtime trust and signed image staging

Issue [#9](https://github.com/stacksjs/drone/issues/9) now has offline signed-image
staging, independent candidate verification and protected initial trust enrollment.
These commands prepare files on the host. Cross-update metadata/release floors,
installed images, boot selection and known-good rollback slots remain to be
implemented. Physical deployment is disabled.

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
Persistent verified metadata/release floors, key lifecycle, interruption recovery
and known-good coordination remain in [issue #42](https://github.com/stacksjs/drone/issues/42).
Do not discard or re-enroll over failed state to reset a security floor.

## Repository and signed image contract

Use a standard TUF repository with `metadata/` and `targets/` directories,
including consistent-snapshot names when enabled. Verification uses the pinned
[`tuf-js` 6.0.0 client](https://github.com/theupdateframework/tuf-js) for root
rotation, signature thresholds, expiration, inter-role versions/hashes and
target length/hashes. A private, randomly addressed loopback server supplies
bounded local files to the client's public HTTP interface. It is stopped after
verification. No external network fetch or arbitrary URL option is provided.
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

The seam alone does not persist a protected prefix or make SDK cache writes
transactional. Its implementation and tests are a prerequisite for the protected
store and recovery coordinator in issue #42. They do not complete that issue or
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

Each verification starts from the supplied root. `trustStatePersisted: false`
means this module has no protected cross-invocation metadata or release
high-water state. It is not a complete anti-rollback implementation. The caller
must supply the trusted release floor every time. TUF expiry uses host wall
time; trusted clock acquisition and protection against clock/storage rollback
remain open. Control-loop freshness still uses its separate monotonic clock.

Initial enrollment is available above. Next, implement protected trust rotation
and persistent metadata/release floors, an
interruption-safe coordinator, installed/known-good slot integrity, explicit
health confirmation and rollback without lowering security floors. Then add
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
