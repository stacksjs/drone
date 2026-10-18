# ADR 17: Qualified depth and explicit visual target pairing

Status: accepted for owned simulation and declared bench-data evaluation.

Keep metric vision separate from the 2D Pi camera session. A selected image box never supplies
metres. Admit registered optical Z only for the exact current selected detection, camera session,
frame and calibration. Validate a fixed Brown5 lens/crop/mount profile against independent held-out
body-frame points before localization. Use a synchronized capture pose with explicit heading alignment.

Retain tracker lock identity across continuity, but expose the exact matched candidate capture
separately. Pair the lock epoch with a chosen GNSS source/session/target and frame. Reject unknown
association, stale/replayed/mutated data and frame changes. Loss latches until clear plus an explicit
new pairing. Existing authority still independently owns rearming and engagement.

Use conservative isotropic uncertainty and covariance intersection for unknown input correlations.
Do not recursively reduce uncertainty by consuming retained packets. Include visible-point-to-target
offset and time-skew motion allowances. This is a bounded position-fusion policy, not VIO, an EKF,
biometric recognition or proof of target identity.

Use native Stacks commands for calibration validation and physics execution, and stx signals with
ts-css utilities for recorded inspection. No database, queue or network transport belongs in the
synchronous localization/fusion loop. Reuse the bounded regular-file reader for CLI profile import.
The reusable storage abstraction already contributed to Stacks remains behind the normal package
release/update path; do not import framework checkout paths into this application.

Synthetic/declared-bench provenance is explicit and never reports physical calibration verified.
The simulator uses qualified sensor prediction for capture pose, independently rendered image/depth,
explicit operator selection/pairing and the existing navigation/authority/control/watchdog pipeline.
The live Pi worker stays 2D. Physical calibration, heading, depth association, HIL and vehicle evidence
remain required as described in the [vision contract](../vision.md).
