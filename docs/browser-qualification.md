# Browser qualification observations

The rendered workspace and execution checks launch a fresh native Chrome process in the
existing fixture-owned process group. They retain the original launch arguments and the
400-read, 50 ms DevToolsActivePort discovery guard. No retry or browser flag bypass is added.
The full page/route/Worker scenarios must still pass. A successful native launcher fixture
does not qualify those scenarios or explain an intermittent Chrome startup failure.

## Startup evidence

`browser-launch.json` retains its exit/port counters and adds a `startup` observation. The
observer requests samples near launch, 1, 5, 10 and 15 seconds, then at discovery end. Samples
run asynchronously during discovery, with at most one actual task in flight and a 500 ms
cooperative cancellation budget. Cancellation stops further process/resource reads after
outstanding native calls settle. It never releases ownership of an unfinished task. A timeout
disables later Linux samples and hashing, closes captured descriptors after settlement and
emits a bounded pending-task notice. Finalization waits for that task; it cannot allow a page
visit behind it. An uninterruptible filesystem call can hold finalization until the existing
outer fixture guard fails and terminates its group. This is not a hard OS syscall deadline.
Actual start/completion epochs are retained; labels are requested milestones, not
promises that an event occurred at that exact time. A pre-page cleanup sample follows the
existing root termination/2 second wait. No process or resource sample is requested after a
page visit. Post-page stderr remains private.

Each sample includes a native root PID existence probe. Linux adds selected `/proc` state:
parent/group/session, start/user/system ticks, thread count, RSS and kernel wait channel.
Names, argv, environment, stacks and memory contents are not exported. Main-task child
traversal and previously observed descendants are capped at 64 processes per sample; root
thread wait details are capped at 32. Start ticks flag observed PID reuse. Fork/exit/reparenting,
permissions and truncation can make this incomplete. It is not proof of whole-group cleanup.
The outer fixture owner separately terminates its isolated group before disposable removal.

Expected discovery-file metadata, observer cgroup-v2 counters and system CPU/memory/IO pressure
help distinguish missing files, a live process and resource contention. Cgroup counters may
cover other runner work; system pressure covers other host workloads. Neither proves Chrome
causality. Unsupported platforms, missing files, permission errors and observation timeouts
are explicit outcomes. Numeric kernel fields are selected and bounded; raw status, cgroup
membership, thread names and arbitrary text are not retained.

Startup samples pin at most four distinct actual Linux `/proc/PID/exe` file descriptors
without reading executable bytes. Only after discovery ends does it hash them under one
2 second cooperative hash budget, with a 512 MiB per-executable limit. Device/inode identity uses exact
integer strings. Byte count and file timestamps are checked before retaining a digest; all
pinned descriptors are then closed, with close errors reported. This identifies an observed
backing executable rather than assuming the configured launcher is Chrome. It neither warms
the binary before the attempt nor authenticates the code or its entire loaded graph.

The browser version is retained only from a successful CDP version response and a closed
Chrome version format. If discovery fails, it stays null. Do not infer the failed binary's
version from another run without matching actual identity evidence. Opening descriptors,
reading process files and hashing are observation work and can affect scheduling; the
observed times and unavailable/timeout outcomes must accompany comparisons.

## Native qualification

```sh
bun test tests/unit/public-safety-browser-launch.test.ts tests/unit/public-safety-browser-launch-evidence.test.ts tests/unit/public-safety-browser-startup-process.test.ts
```

One actual native fixture exits 23 before discovery. Another owns a live child until the
original cleanup request. The checks preserve all 400 failed probes, inspect actual PIDs,
verify parent/child shutdown and ensure argv/environment sentinels do not enter the report.
On Linux the live fixture also checks actual descendant/start/RSS data and the retained
executable hash against the independently read runtime binary. Optional `BROWSER_LAUNCH_EVIDENCE`
and `BROWSER_LAUNCH_LIVE_EVIDENCE` retain reports in new directories. CI publishes only the
allowlisted launch JSON and startup stderr, not scripts, credentials or private fixture files.
A held OS-adapter promise separately verifies that cancellation cannot overlap another sample,
finalize early or begin hashing while an operation remains unfinished. It does not qualify
Linux field acquisition; the actual native Linux fixture provides that evidence.
A Linux cancellation case also opens real executable descriptors and checks that they are
closed without a digest once the held native sample settles.

Linux-only observations require Linux evidence; a macOS pass does not establish them.
[Issue #72](https://github.com/stacksjs/drone/issues/72) retains the original failed attempts and
passing controls. Its root cause and correction remain open until reproduced and verified.
These observations change evidence, not aircraft control, physical outputs or flight readiness.

Field semantics follow the kernel's [proc reference](https://docs.kernel.org/filesystems/proc.html),
[cgroup-v2 reference](https://docs.kernel.org/admin-guide/cgroup-v2.html) and
[pressure reference](https://docs.kernel.org/accounting/psi.html).
