# Signed runtime image staging

Issue [#9](https://github.com/stacksjs/drone/issues/9) now has offline signed-image
staging and independent candidate verification. These commands prepare files on
the host. Persistent trust state, installed images, boot selection and known-good
rollback slots remain to be implemented. Physical deployment is disabled.

## Explicit trust and policy

Enroll an initial TUF `root.json` and its SHA-256 through an independent trusted
channel. Do not calculate a pin from an untrusted bundle and call it trusted.
The release floor must likewise come from externally trusted release policy.
Every invocation requires the root pin, exact target, expected bench platform
and positive minimum release sequence. There are no permissive defaults.

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

## Repository and signed image contract

Use a standard TUF repository with `metadata/` and `targets/` directories,
including consistent-snapshot names when enabled. Verification uses the pinned
[`tuf-js` 6.0.0 client](https://github.com/theupdateframework/tuf-js) for root
rotation, signature thresholds, expiration, inter-role versions/hashes and
target length/hashes. A private, randomly addressed loopback server supplies
bounded local files to the client's public HTTP interface. It is stopped after
verification. No external network fetch or arbitrary URL option is provided.

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

Next, implement persistent trust enrollment/rotation and release floors, an
interruption-safe coordinator, installed/known-good slot integrity, explicit
health confirmation and rollback without lowering security floors. Then add
the board bootloader/install protocol and measured power-loss, full-medium,
storage-latency and recovery campaigns. Local privileged filesystem tampering
is outside this host module's protection; it is not secure boot or hardware
anti-rollback. See [TUF's workflow and threat model](https://theupdateframework.github.io/specification/latest/).

Tests use generated throwaway Ed25519 keys and clearly synthetic payload bytes.
They cover real role signatures/rotation, expiration, compatibility, supplied
release floors, tampering, bounded inputs, incomplete candidates and native/
portable CLI behavior. They establish host behavior, not actual firmware
installation, board boot recovery or commissioning. The diagnostic supervisor's
update/rollback check remains blocked and `commissioningReady` stays false.
