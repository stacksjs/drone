# Owned host slot health

Status: implementation in progress for #42. Physical deployment remains disabled.

The metadata store and candidate archive authenticate bytes without observing a
runtime. Add host slot roles and health confirmation to that same exclusive
protocol operation. Keep the immutable enrollment and pinned store identity.
Format3 extends format2 atomically with host slot records, one installed role,
one known-good role and bounded ordered command/status inputs. The writer file
remains format1. The [bounded protocol SQLite decision](0028-runtime-trust-store.md)
still applies; these records are not application CRUD.

The host trial requires `host-neutral-bench-v1`, an explicit trusted local source
checkout at the signed Git revision, and a clean firmware tree. Build and CTest
that source, then require exact byte equality with the currently authenticated
candidate. A signed profile declaration alone cannot reach runtime execution.
Retain a separate private, non-executable slot image. Observe the corresponding
byte-identical local host build. The source checkout, compiler and host OS remain
trusted inputs; this is not a general executable attestation scheme.

Commit selection before image IO. After copied-image readback, record the running
host role while retaining the previous known-good role. Allocate boot and session
challenges within the actual supervisor. Commit every bounded command/status input
before interpreting health. Require progressing samples, the exact 100-tick neutral
trial, the matching stop reply, clean process exit and complete allowed output.
Recheck executable/slot bytes and the independently supplied clock. Commit the
final time observation and its floor before checking expiration, so a rejected
confirmation cannot discard trusted time. Check metadata expiration with local
elapsed time and a one-second sample freshness limit before atomically recording confirmation, the new known-good role,
the completed clock floor and release of the candidate reservation. No caller
boolean, typed receipt or existing marker can perform that transition.

The Linux transport regression uses a native C++17 fixture with the existing
wire codec. It reports kernel FIFO capacity and queued bytes without consuming
stdin, filling a complete kernel page before testing blocked-write cleanup.
The test supports 4 KiB, 16 KiB and 64 KiB pages. It is host transport evidence;
physical UART, board timing and electrical faults have separate acceptance gates.

Reservation lifetime and slot lifetime are separate. A confirmed candidate's
reservation becomes retired so a new candidate can be prepared. Its candidate
history and files remain, and the separately confirmed slot role retains its own
image and transcript. Historical confirmed records are not fresh current-policy
authorization. Slot inspection rechecks record/byte integrity and the whole
retained host transcript; it does not grant runtime authority.

Metadata recovery preserves its verified prefix and security floors. An unfinished
selected/running trial needs explicit abandonment by exact ID after that recovery.
Abandonment retains files, inputs and the prior known-good role. A real completed
confirmation transaction survives a crash before the enclosing attempt returns;
recovery preserves that observed result without inventing another confirmation.

Rollback selects the retained known-good identity under the same writer lease,
checks its retained image, performs fresh current-time signed verification, and
observes another actual runtime session. It cannot reuse the old health record as
new health. Expired, revoked, below-floor, missing or corrupt images fail closed.
The fixed policy target must currently authorize the exact image; older cached
metadata cannot override a replacement target or the global release floor.

These are host virtual-clock and local-file assertions. Actual board image/build
attestation, bootloader installation, electrical power-loss recovery, secure boot,
hardware anti-rollback, physical timing and commissioning still need their own
implementation and measurements under #2/#9. Authenticated key repair and the full
short/zero-write, ENOSPC/EDQUOT/EIO and sync-failure campaign remain required by #42.
