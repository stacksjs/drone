# Behavior coverage audit

The executable audit accounts for the 274 pinned PX4 module/driver and ArduPilot library directories
and six ArduPilot vehicle programs. Directory assignment is work ownership. It is not feature parity.

The retained matrix is [parity-audit.json](https://github.com/stacksjs/drone/blob/main/docs/parity-audit.json). It currently contains **79 behavior
cases**, including **26 bounded support claims** backed by **25 distinct executable test selectors**
and **53 explicitly unsupported cases**. There are **1,327 unclassified detail dimensions**.
The audit retains **42 pinned source records**. No upstream firmware SITL, HIL or physical-vehicle
validation is claimed by this audit.

Every assignment classifies parameters, modes, protocols, hardware and failures separately. A
reviewed dimension means it has at least one concrete source-backed case. The `remaining` field
explicitly preserves deeper review work, including within reviewed dimensions. An unclassified
dimension means source review has not established its behavior inventory. It never means supported,
absent, or unnecessary. `unsupported` identifies an examined behavior unavailable in this application;
`unimplemented` is available for reviewed planned cases. These are gaps, even when an issue owns them.

## Run the coverage gates

```sh
# Offline structural coverage and evidence-reference gate.
bun scripts/parity-check.ts

# Execute the exact public behavior tests behind every support claim.
bun scripts/parity-check.ts --run-evidence

# Verify actual pinned upstream bytes, Git blob/SHA256 hashes, license files and cited symbols.
# Requires authenticated gh access to public GitHub repositories.
bun scripts/parity-check.ts --verify-sources

# Check that each retained issue URL still resolves to the expected GitHub issue.
bun scripts/parity-check.ts --verify-links

# Fail when asked to certify full parity. Schema v1 only represents subsets and gaps.
bun scripts/parity-check.ts --require-complete

# Reproduce the pinned directory snapshot from bounded GitHub API listings.
bun scripts/parity-refresh.ts --output /tmp/drone-pinned-review.json
bun scripts/parity-check.ts --snapshot /tmp/drone-pinned-review.json

# Prepare a newer revision for review without changing the accepted baseline.
bun scripts/parity-refresh.ts --px4 main --ardupilot master --output /tmp/drone-upstream-review.json
```

The structural command exits successfully for a valid, explicitly incomplete audit. Its JSON always
includes `parityComplete: false`: the schema contains only subset support and gaps and cannot certify
complete upstream equivalence. `reviewComplete` also stays false while any dimension or retained
review work is unresolved. Use `--require-complete` when full parity is the requested release gate;
it fails. This deliberate distinction lets CI reject regressions without silently equating honest
incompleteness with a parity pass.

Coverage fails for unassigned entries, duplicate cases/assignments, dangling local issue URLs,
missing reviewed cases, mutable source revisions, missing license provenance, absent source/limits,
missing test selectors and fabricated evidence environments. A test selector must execute exactly
one passing test; a successful Bun process that selects zero tests fails evidence verification.
An evidence run invokes existing behavioral tests through their public function seams, rather than
asserting that implementation files exist. Selector failures include bounded diagnostic output.
The run does not promote its evidence environment or change support classifications. Evidence commands share the bounded process owner with upstream requests: each selector has a 60-second deadline and a 1,000,000-byte cap on each output stream. Timeout or overflow records a failed case and continues to the next selector. Cleanup uses SIGKILL, cancels the readers and reaps the direct child; on POSIX it also terminates the owned process group so inherited descendant pipes cannot extend the deadline.

## Review upstream changes

Refresh resolves each requested ref once to a full commit SHA. All subsequent API listings use that
immutable revision. It reads only the selected roots, rejects ambiguous/truncated listings, and emits
a separate candidate snapshot. It never overwrites accepted inventory, issue ownership, behavior
classifications or support claims. It creates the output exclusively after fetching, so existing files and concurrent writers cannot be overwritten. GitHub process stdout is capped at 2,000,000 bytes and stderr at 65,536 bytes while streaming. Overflow or the 20-second deadline kills the child, cancels both readers and awaits cleanup before returning.

Comparison reports added, removed and changed directory trees and changed upstream revisions. New
ArduPilot root directories also require classification so a new vehicle family cannot disappear
outside the library inventory. Known infrastructure roots are explicitly classified. Changed
infrastructure tree contents alone are outside the selected coverage scope; libraries and known
vehicle-family trees are compared independently.

Any difference exits nonzero with `reviewRequired: true`. Assign every new directory to a real
retained roadmap issue, inspect changed/removed behaviors, review source hashes and citations, and
update the accepted inventory and matrix together. The current 274-entry scope guard must be
intentionally updated with a reviewed scope change. A branch/ref name is never retained as evidence.
The source verifier can be run separately because it makes one bounded request per source file.
Offline coverage alone does not prove remote source bytes or availability.

## Provenance and evidence

Each case links an immutable source file, exact line and symbol. Source records include the pinned
firmware source revision, Git blob hash, SHA256, line count, license identifier and pinned license
file. PX4 source is tracked under BSD-3-Clause and ArduPilot source under GPL-3.0-or-later. These
records document research provenance, not copied implementation code or a redistribution assessment.
Source files remain upstream; this repository retains citation metadata rather than vendoring them.

Firmware source revisions describe what was reviewed. Executable evidence separately records
whether firmware was actually run. All retained claims currently record `firmware.status: not-run`
and null firmware version/revision. Unit tests, owned physics simulation, scripted protocol peers,
host bench, firmware SITL, HIL and vehicle evidence are distinct categories. Real SITL/HIL/vehicle
claims require a tested firmware version, immutable revision and retained evidence artifact. The
gate checks those references; human review still establishes artifact authenticity and whether the
measurement supports the claim.

The reviewed cases cover AP HAL scheduling versus the owned neutral-only runtime, ICM-42688-P and
BMP280 acquisition/arithmetic, calibration and clock failure guards, complementary attitude and
height estimates versus full EKF2/EKF3, rate PID/quad-X simulation, authority latches versus upstream
arming modes, MAVLink ACK/parameter/mission subsets, camera trigger/ACK differences, and mission
execution/recovery. All six ArduPilot vehicle mode families have explicit unsupported full-mode cases.
Ten additional unsupported cases sample the pinned [PX4 gimbal module](https://github.com/PX4/PX4-Autopilot/tree/ddcaad6601be20453ec6acd0f08e567af3a7e1bb/src/modules/gimbal)
and [ArduPilot AP_Mount library](https://github.com/ArduPilot/ardupilot/tree/afeb9c4941543d97f3e04fecf257b8f598f49a6a/libraries/AP_Mount),
covering parameters, input/target modes, manager/device protocols, hardware outputs and failure
policies. Their ten source records retain exact file hashes and line/symbol citations. The original
59 cases and 26 support claims are unchanged. Both directories remain owned by payload issue #8;
their reviewed dimensions retain explicit deeper work and do not constitute exhaustive review.

The [owned Cinema simulation](cinema.md) implements a separate hover POI angular reframe with
modeled joints, encoders and still exposures. It does not implement those firmware modes,
manager ownership/discovery, normalized AUX/servo outputs, electrical behavior or device health
policies. Generic command/parameter transport also does not supply gimbal-specific semantics.
These cases add source-backed gaps without new executable support or firmware execution claims.

Ten further unsupported cases sample pinned PX4 `camera_feedback` and `camera_capture`:
live report-flag gating, geotag orientation selection, uORB capture/control records, feedback-source
selection, strobe timing, pin backends and input rejection/rate faults. Four new source records
preserve exact citations; the prior 69 cases and 38 sources stay unchanged. The feedback tag does
not authenticate physical exposure, and the downstream MAVLink streamer remains unreviewed.
Upstream explicitly marks capture modes 1 and 2 not fully tested; their actual exposure/sequence
arithmetic is not treated as an ideal midpoint model. The rate counter decays on acceptable
intervals and its fuse applies to the timer callback, not the separate GPIO path. A control ACK does
not prove hardware enablement. Board wiring, electrical/timing calibration, PPS/RTC mapping and
queue/restart behavior remain deeper work. The owned IMX500 first-row metadata, scoped capture
ACK/pose association and modeled shutter remain separate capabilities, with no new parity claim.

Unreviewed parameters, full firmware mode sets, serial/CAN/electrical variants, redundant estimators,
real output paths, simulator campaigns and hardware evidence remain visible gaps owned by their
implementation issues.
