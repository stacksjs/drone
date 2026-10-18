# ADR 18: separate survey collection from reconstruction

Status: accepted for the owned simulation slice of issue #18.

Survey planning and exposure collection run on the owned mission, estimator, authority and control
contracts. They do not depend on an external autopilot. Plan validation uses declared coordinate,
terrain, calibration, GSD, overlap, trigger and endurance constraints before execution. Execution
retains existing mission resource/fence limits and rejects plans it cannot represent.

Shared calibrated-camera geometry belongs to this drone library: target localization and survey
footprints use the same lens/crop/mount implementation. Stacks owns native command discovery, stx
reactivity and application delivery. Server exports use the underlying image codec with a direct
runtime dependency; a responsive-variant image builder is not a raw camera renderer. No new generic
framework facade is needed for domain-specific survey policy.

Only the synthetic measurement renderer sees plant truth. Accepted exposures retain scoped ACKs,
estimated capture poses, calibration and explicit correction/control-point availability. ODM input
files carry real encoded images and declared optical-center geotags, with a completion manifest.
Collection reports and mission replay cannot imply reconstruction, measured precision or physical
survey acceptance. See [mapping contract](../mapping.md) for evidence limits and remaining work.
