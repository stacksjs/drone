# Explicit continuation of unresolved update attempts

Status: implementation in progress for #42. Physical deployment remains disabled.

A metadata attempt can retain a verified root/timestamp/snapshot prefix and then
reject later input. Ordinary recovery cannot turn an unknown verifier, crypto or
resource error into proof of invalid input. Replaying that exact input can fail
again after the repository has been corrected, leaving no supported fresh path.

Add an explicit local maintenance continuation. The caller supplies independently
retained enrollment/store pins, the exact unresolved attempt ID, an independently
trusted current clock, and acknowledgement that the original inputs remain
unresolved. Existing protected ownership and exclusive-writer checks apply. This
is an operator action, never automatic error classification or silent retry.

Format 4 adds immutable predecessor/successor handoffs. In one SQLite transaction,
retain the original attempt unchanged, create a new pending attempt at the current
committed generation, record the handoff, and retain the new clock observation.
Exactly one unresolved successor remains active. Older readers reject format 4
before rewriting either database. The writer database stays format 1. Formats
1/2/3 migrate atomically while preserving all metadata, inputs, floors, candidates,
slots and their independent store identity. This remains the local protocol
exception in [ADR 28](0028-runtime-trust-store.md), with native Stacks CLI entrypoints.

Every prior input, accepted observation, phase and release remains retained. A
handoff says only that the operator requested fresh verification; it does not say
the prior input was invalid, recovered or successfully verified. Public status
exposes the chain and bounded input digests/counts for investigation. Chains are
forward-only, bounded by the existing attempt limit and checked against attempt
ordering, generations and clocks. There is no automatic deletion or compaction.

The successor uses the existing signed metadata verifier and persistence path
from the latest committed root and high-water state. No trusted root, metadata
epoch, release floor or clock floor is reset. New root continuity and role checks
still follow [TUF's client workflow](https://theupdateframework.github.io/specification/latest/#detailed-client-workflow).
Only a full fresh metadata verification completes the successor. It neither
downloads an image nor changes installed/known-good roles. Candidate selection,
rollback and boot confirmation still require their own fresh-policy checks.
Unverified predecessor inputs remain retained; the handoff does not automatically
replay or authenticate them. This differs from historical recovery, which replays
the active attempt's exact durable inputs. Neither path can decrease a committed
security floor.

A rejected or interrupted successor remains pending/maintenance and blocks normal
operations. Historical recovery addresses that active successor only and cannot
promote a retained predecessor. An explicit continuation can itself be continued
after another rejection, preserving the complete chain and all security floors.
Crashes at handoff/input/metadata boundaries and actual concurrent writers need
qualification. Missing or corrupt state continues to fail closed.

This supplies a supported path after unresolved repository input, including
authenticated key rotation through existing root continuity. It does not invent
authority to replace a lost root, decrease a poisoned clock floor, repair corrupt
history or bypass revoked/expired metadata. Independent recovery authority and
trusted-clock repair still need their own design and acceptance. Physical board
installation, anti-rollback and electrical power-loss qualification remain open.
