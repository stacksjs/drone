# ADR 8: Owned camera acquisition and payload contracts

Status: accepted for fixture development; physical acceptance pending.

Use an owned TypeScript camera adapter, with the existing narrowly scoped Picamera2 acquisition
helper for IMX500 hardware. Both replay and physical adapters return bounded, session/boot/sequence
correlated image ACKs. Sync each physical transaction with a measured local IPC round trip instead
of assuming Bun and Python share a clock origin. Never retry a shutter after an ambiguous outcome.

Associate capture epochs with a bounded history of qualified owned-estimator snapshots. Preserve
component epochs, reference/reset provenance and uncertainty. No real capture may use fixture pose
evidence. Relative yaw and uncalibrated camera timing/mount remain explicitly ungeoreferenced.

Native Stacks commands own bench and local capture export, and the standalone CLI reuses those
command definitions. Camera ownership stays exclusive between tracking and still acquisition.
Local artifacts use exclusive new directories because overwrite protection is part of this boundary.
Cloud storage, jobs and durable operational logging belong to later work, not this capture contract.

Bus contracts and payload inventory cover issue #8 without claiming generic device support. Only
CSI acquisition is implemented; physical camera validation, electrical bus drivers, calibration and
actuator authority require measured follow-up evidence. Keep issue #8 open for those gates.
