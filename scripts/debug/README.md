# Native Linux browser startup research

`browser-startup-probe.ts` is a bounded capability campaign for issue #72.
It imports no application code, visits no application page, and does not
qualify the Drone product. Every trial has a new profile and uses the original
Chrome flags and 400 reads with a 50 ms polling interval. All 24 trial results
are retained, including failures. Failed startup is not retried until green.

The campaign records the actual executable/version, process-group and thread
state, cgroup counters, discovery-file observations and bounded startup stderr.
Snapshots run outside the discovery loop. Owned Chrome groups are terminated
and joined before another trial starts. Profiles are separate from the flat
artifact allowlist. Failed profiles stay private on the disposable runner.

The research branch's manual-only CI replacement must not be merged into main.
Its result cannot replace the original failed product qualification. Any fix
needs a demonstrated cause and fresh qualification through the normal product
workflow. A clean campaign alone does not explain the original failure.
