# Full host filesystem qualification

Status: implementation in progress for #42. Physical deployment remains disabled.

Extend the public update-coordinator storage campaign with actual Linux ENOSPC.
Run explicitly inside a private mount namespace, verified against PID 1's mount
namespace, with kernel mountinfo readback rejecting shared or slave propagation.
Mount a new 16 MiB tmpfs only at an exclusively created private fixture
directory. Read back the filesystem type, capacity, ownership and mount identity.
No block device, existing mount or physical vehicle is involved.

Keep signed repositories and the owned build outside the bounded filesystem.
Place the actual protocol store, candidates and slots inside it. Confirm a real
release-7 host session, prepare release 9, then publish new signed root/role
metadata. At the public slot-selection progress boundary, fill an owned sibling
file through real writes until ENOSPC. Run two independent campaigns: release
only 1 MiB of its allocation for a partial image write, or leave zero free bytes
for failure before any image bytes are written. Pin the selected budget in the
private fixture marker and worker input, and read it back from the filesystem
before the copy. Require exactly the selected number of retained image bytes,
including an existing empty image file and its SHA-256 in the zero-byte case. Leave
the filesystem full until the trial process has exited, including its attempts
to record failure. Never replace filesystem or SQLite methods with faults.
The existing public inspector reports an empty image as `unavailable` because
valid protected images must be nonempty. A nonempty partial image is `mismatch`.
Neither status grants health or installation authority; the campaign separately
reads the actual retained file to distinguish empty, partial and missing bytes.

Inspect retained bytes and public status after removing only the owned filler.
Require the previous known-good image and accepted metadata/security floors to
survive without a new health confirmation. A pending attempt and selected slot
must undergo explicit fresh-process metadata recovery and exact-slot abandonment
before an unrestricted fresh trial can confirm a different slot through actual
new boot/session evidence. Preserve failed partial or empty files and the older image.

Copy and hash the full volume before freeing the filler or opening it for
inspection, then archive later retained states before unmounting the volatile
filesystem. Keep failure observations, status snapshots
and process results. CI retains these synthetic artifacts for seven days.
The opt-in Linux qualification must execute in CI; a skipped local test supplies
no positive filesystem-exhaustion evidence.

Linux documents tmpfs capacity limits and loss of contents on unmount in
[tmpfs(5)](https://man7.org/linux/man-pages/man5/tmpfs.5.html). This is real logical
filesystem exhaustion on a memory-backed filesystem. It does not qualify storage
device exhaustion, a write syscall returning zero without an error,
persistent-media durability, EDQUOT, EIO, sync failures or
electrical power loss. Those remain separate acceptance requirements. The fixture
adds no production storage layer, privileged application command or dependency.
