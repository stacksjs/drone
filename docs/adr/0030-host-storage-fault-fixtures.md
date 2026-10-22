# Host storage fault fixtures

Status: qualification in progress for #42. Physical deployment remains disabled.

Exercise storage failures through the existing public update coordinator with
real signed repositories and separate processes. Keep the enrollment, protocol
store, owned candidates, host slots and current-policy checks in the path.
Assertions read public status and actual retained files. No filesystem method or
SDK verifier is replaced.

The first campaign uses POSIX `RLIMIT_FSIZE` on macOS and Linux. A test-only C++17
launcher sets and reads back the child's hard and soft limit, ignores `SIGXFSZ`
so an over-limit write can report `EFBIG`, then executes Bun. This small native
test exception supplies the kernel resource control that the TypeScript harness
needs. It is not linked into the application or board runtime. Stacks' bounded
process capture owns command execution and output.

A disposable signed source checkout adds initialized padding to its host image.
It retains the neutral kernel behavior and forces the authentic executable past
the file-size limit. Prepare candidates and the prior known-good image before
the limited process starts. New signed metadata is accepted during the limited
trial. The host-slot copy must then make real partial progress and fail before
runtime launch or health confirmation.

Retain the partial slot file and prior known-good bytes. Verify metadata and
release floors after rejection and a fresh recovery process. A later unrestricted
trial needs a new slot and actual fresh runtime health; it cannot complete the
failed slot by marker inspection. The large padded image is a host fixture,
without a board memory or timing qualification claim.

This establishes a process-local file-size-limit failure, including an actual
short image write. It does not establish zero-return writes, ENOSPC, EDQUOT, EIO,
sync failure, full-medium behavior or electrical power-loss durability. Those
remain explicit parts of the full storage campaign. Authenticated maintenance,
board installation, boot recovery and hardware anti-rollback retain their own
acceptance gates.
