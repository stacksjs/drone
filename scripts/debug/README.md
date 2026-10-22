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

## Restore the actual workspace startup context

`workspace-startup-campaign.ts` runs 12 fixed controls through actual native
accounts, authorization, SQLite, STX compilation and server initialization. It
uses the same isolated browser driver and inherited Chrome process group as
the original failure, then closes after discovery/CDP setup before visiting a
page. Startup observations are explicitly opt-in and occur after the unchanged
400-read/50 ms discovery loop. This is still not the complete browser scenario
or a product qualification. The original TCP source is an ancestor of this
research source.

The existing bounded fixture supervisor retains a maximum 2 MB per stream and
checks process-group absence. Raw application output and private profiles stay
outside the upload allowlist. Every completed trial is retained, including
failures; cleanup uncertainty stops the campaign. The campaign checks observed
Chrome binary content before and after the sequence, without claiming continuous
immutability. Keep the research-only workflow and startup-only mode off main.
