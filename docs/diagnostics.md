# Owned runtime diagnostics, journals and replay

Issue [#9](https://github.com/stacksjs/drone/issues/9) adds runtime-only black-box journals,
loss accounting, crash-prefix recovery, provenance and offline replay. Native Stacks commands and
a stx viewer use the same verifier and replay projection. This is an initial host-runtime slice,
not full mission reconstruction, physical crash validation or signed firmware management.

## Record and inspect a failure

```sh
# Requires the native host compiler/CMake toolchain from docs/runtime.md.
./buddy diagnostics:record --ticks 1000 --fault deadline --output /tmp/new-runtime-recording
./buddy diagnostics:replay /tmp/new-runtime-recording/journal.ndjson --at-ms 1000
./buddy diagnostics:inspect /tmp/new-runtime-recording/journal.ndjson
./buddy diagnostics:inspect /tmp/new-runtime-recording/journal.ndjson --check
./buddy diagnostics:export /tmp/new-runtime-recording/journal.ndjson --output /tmp/new-runtime-export
```

Use `--fault none` for a clean bench, or `deadline`, `stale`, `expiry`, `replay` or `version` to
exercise the existing native runtime scenarios. `--ticks` accepts 1..100000. Recording defaults
to the deadline experiment. The command builds and runs the actual C++ host HAL, observes command
attempts before transport and status replies afterwards, and returns the original bench report
plus the verified diagnostics. It never opens a physical vehicle transport. A fault experiment
can finish successfully while its recorded health check fails.

`inspect --check` exits nonzero for observed diagnostic failures such as loss, incomplete capture
or deadline faults. Exit zero only means the recording's diagnostic checks passed. It is never
approval to commission hardware: `commissioningReady` and `physicalFlightEnabled` stay false,
and physical commissioning and signed update/rollback checks always remain blocked.

Commands are ordinary `defineCommand()` modules under `app/Commands/`. The standalone CLI reuses
them through `bin/drone.ts`:

```sh
bun run runtime:cli
/path/to/drone diagnostics:record --project /path/to/drone-source --ticks 20 --output /tmp/new-bench
/path/to/drone diagnostics:replay /tmp/new-bench/journal.ndjson
```

Recording needs the source checkout and host compiler. Inspecting, replaying and exporting an
existing journal work outside the checkout without compiling firmware or opening devices.

## Inspect in the Stacks UI

Open `/diagnostics`. Choose a local `.ndjson`/`.jsonl` file or load the packaged deadline example.
Verification and replay happen inside the tab; selecting a file does not upload it, persist it
in browser storage or connect a vehicle. Hash verification needs HTTPS or a trusted localhost
secure context. The example is the only journal fetched from the application server.

The viewer shows evidence, completion, known loss, unknown crash tail, firmware/configuration
provenance, performance counters, boot segments and fault transitions. The time slider, Beginning
and End controls let you inspect recorded epochs. Seeking backwards creates a new pure replay;
CLI/library replay instances require monotonically advancing time. Clearing the viewer discards
its parsed journal from application state. Browser and OS file caches remain outside that promise.

The [retained example](https://github.com/stacksjs/drone/blob/main/public/diagnostics/runtime-deadline.ndjson) is an actual 20-tick native
host recording: no fault at 20 ms, a deadline miss at 22 ms, 46 verified events, no recorded loss.
Its random run/session identifiers and platform-specific firmware digest identify that original
capture. Re-recording the same experiment should reproduce the fault and counters, not identical
file bytes or identifiers. It is host virtual-clock evidence, not a board timing measurement.

## Version 1 journal and privacy boundary

A newline commits each JSON record. A canonical, strict header identifies the format, v1 schema,
UUID run ID, declared evidence, byte/event budgets and provenance. Each event carries an increasing
attempt sequence, local relative milliseconds, typed payload, previous digest and SHA-256 digest.
The header's canonical SHA-256 seeds the chain. The completion marker seals final attempt/write/drop
counts, last local epoch and reason. Canonical object field order is defined by the verifier;
unknown fields and incompatible versions are rejected rather than displayed or exported.

Only these payloads are accepted:

- Runtime command attempts and status frames with numeric fields and exact decimal uint64 IDs.
  Commands contain no opaque payload fields. A transmit record is an attempt, not proof of delivery.
- Virtual board tick epochs.
- Enumerated health events: transport loss, host error, clock discontinuity, watchdog reset,
  deadline miss and rejected protocol input. Malformed/version-incompatible commands contribute
  a fixed rejection code instead of raw unknown bytes or exception messages.

There are no free-text contexts, environment snapshots, operator token, image, GNSS, filesystem
path, network address or private payload fields. Invalid event input is rejected before it reaches
the queue. This allowlist is not a generic text-log redactor and cannot prevent a caller from
intentionally encoding secrets inside numeric values or replacing digests with secret-shaped data.
Never adapt ordinary application logs or unknown network buffers by copying arbitrary properties.

SHA-256 chaining detects accidental corruption, removal/reordering and partial writes against the
retained chain. It does **not** authenticate the source or prevent an attacker rewriting the entire
file and recomputing hashes. Declared `board-capture` evidence is not hardware attestation.
Cryptographic signing, trusted keys and anti-rollback are separate work. Export creates a new
private local directory and includes only verified schema records; it drops an incomplete crash
tail while preserving its unfinalized status. A whole-file SHA-256 identifies the exported bytes.

## Versions, clocks, health and reset evidence

Every recording carries firmware, configuration, model and calibration SHA-256 identifiers plus
runtime protocol version. The host recorder hashes the exact compiled host artifact, the selected
bench options/protocol limits and the native runtime model source. The calibration identifier is
SHA-256 of `not-applicable:synthetic-runtime-sample-v1`, because this HAL produces synthetic samples
and applies no physical sensor calibration. These IDs must not be described as measured board
calibration. A future physical producer must supply actual build/config/model/calibration versions.

Runtime frames preserve board capture microseconds, status sequence, board/session IDs, tick and
deadline counters, maximum execution time, state bytes and flags. Local record timestamps use the
host HAL's virtual timeline. They are not host wall-clock timestamps or measured wire latency.
The reducer detects boot changes, board clock reversal, status gaps/replays, watchdog flags, deadline
faults, unknown capability flags and missing neutral profile. It does not fuse sensors, regenerate
missing data, simulate physics, resend commands or grant runtime authority.

Header digests identify inputs but do not embed complete configurations or artifacts. Keep those
artifacts separately when reproducing a build; hashes alone cannot reconstruct them. Full sensor,
estimator, authority, mission and payload correlation remains future work under #9.

## Bounds, durability and failure behavior

Defaults are at most 4 MiB, 4096 events, 4096 bytes per complete line, 24 hours of local relative
epochs and 32 pending records, with a configurable queue of 1..64. Configuration is snapshotted at
open. Output directories must be new and their parent must exist. Directories use mode 0700 and
files use 0600 on POSIX systems. Existing outputs, including final symlinks, are not overwritten.
Reading accepts bounded regular files and rejects final-component symlinks and device/FIFO inputs.
Export does not delete or repair the original evidence.

The recorder uses one asynchronous writer. The public `DiagnosticStorage` byte port supports
controlled host I/O fault tests, while `openDiagnosticsRecorder` owns the exclusive local file. It copies and validates event data before enqueueing,
handles partial writes and bounds queue memory. Queue pressure, event limits and byte limits each
drop new events with separate counters; sequence gaps expose losses in the verified prefix. This
first format retains the **first** bounded window, rather than rotating and overwriting evidence.
It cannot reconstruct a failure outside that window. Capacity exhaustion leaves room for a final
loss-accounting marker. Rotation and longer missions need a separately versioned retention policy.

Header creation and normal close are fsynced. `flush()` drains and fsyncs; `flush({ sync: false })`
only drains writes to the OS. The virtual host recorder drains around each exchange and fsyncs at
close. Storage I/O is outside firmware scheduling; record execution time is not a benchmark of
real-time logging on the board. No motor loop waits on this recorder.

On storage failure, the writer retires pending records, counts storage drops, rejects successful
completion and closes the descriptor. ENOSPC/EDQUOT are reported as a full-storage state. The local
verified prefix is retained, possibly ending inside an incomplete line. A clean completion marker
cannot be guaranteed when the medium refuses further writes. A valid completion record can exist
even if the subsequent fsync fails: the caller still receives failure. File `completed` describes
logical completion, not confirmation that the final sync succeeded. Power loss can also remove buffered
OS/device writes despite earlier accepted events; do not infer durable capture from append success.

An unterminated final line is discarded on recovery. Complete malformed or corrupt records,
reordered sequences, broken hashes, invalid accounting and bytes after a completion marker fail
verification. Missing completion always reports `tailUnknown: true`; visible sequence gaps are
only a lower bound on total loss. It never reports an interrupted mission as a clean run. Process
crash tests confirm recovery after SIGKILL following an explicit flush. The host storage port tests short writes, zero progress, ENOSPC/EDQUOT/EIO, partial failed records
and startup/flush/completion sync failures, including descriptor cleanup and prefix recovery.
Physical flash power-loss, full-medium and electrical I/O fault campaigns are still required.

## Remaining operational acceptance

- Connect live owned runtime/sensor/estimator/authority streams with measured clock relations and
  versioned calibration/configuration artifacts, then replay a complete mission failure.
- Measure board flash/storage latency, loss/rotation policy, logging deadlines and RAM under load.
  Exercise ENOSPC/EDQUOT, torn sectors, storage removal, host crash, power loss and reset causes on
  the actual Pi/Pico setup. Disabled loads and independent authority remain required.
- [Signed image staging and protected preparation](runtime-updates.md) authenticate
  TUF roles, declared compatibility and actual image bytes. Independently pinned
  enrollment/store records retain metadata and clock/release floors; historical
  recovery retains floors only. Owned candidate reservation/status/retirement retain
  exact identities and files without granting boot authority. Host slots now add
  actual owned-image session confirmation and fresh-policy rollback. Complete key
  repair, full write/sync/storage-fault coverage and board image/install/boot/health
  qualification before flashing. Standalone staging/inspection still need explicit
  trust and remain separate from protected-current-policy selection. Host evidence
  does not satisfy physical update/rollback or hardware anti-rollback acceptance.
- Implement a commissioning workflow backed by measured wiring, neutral outputs, watchdog,
  estimator calibration, RC override/kill and recovery evidence from #2/#3/#4/#6.

These remain in [#9](https://github.com/stacksjs/drone/issues/9). Passing file checks, a host
recording or a green CI run does not satisfy physical commissioning or update acceptance.
