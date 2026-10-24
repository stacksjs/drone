# 0034: Cargo missions use captured custody and the shared vehicle runtime

## Decision

Build cargo delivery on `VehicleMissionPlan`, `VehiclePayloadPort`, the owned quad-X
plant and the existing raw sensor/estimator/control/authority/watchdog loop. Keep
point-mass dynamics and independent parcel motion in the model, and put release and
custody policy behind a separate modeled coordinator. Plant truth cannot mutate
policy custody directly.

The public simulator accepts an explicit configuration for load/CG, receiver, release
height, alternate and declared power budget. A pure planner validates the complete
normal/alternate graph before allocating a world. Native Buddy commands provide the
application entrypoint; the standalone CLI registers the same command implementation.
No framework package abstraction is introduced for cargo-specific policy.

Release is a single scoped operation after qualified captured dwell. Intent, mechanism
open/jam, receiver receipt and carrier completion are distinct observations. Unknown
dispatch remains uncertain. Terminal uncertainty cancels before discarding its event;
authority loss and close retain the same cancellation path. Receipt requires matching
event/container/site/recipient evidence and a qualified finite capture-time ACK pose.

The shared mission engine's optional cargo payload failure edge is a finite, one-way
alternate approach and landing. Its budget includes that path. It cannot retry release,
replace the authority fence or bypass a source/authority failure.

Two captured link sources belong to the same vehicle/boot/session scope. Switching
between them does not transfer mission authority or parcel custody to another vehicle.
Foreign/replayed/stale packets and complete source loss cannot silently renew authority.

Post-release and post-receipt fault fixtures bind to observed policy events. Independent
settling continues only board/plant physics after host processing stops. Later physical
parcel contact cannot create a host receipt, and an earlier receipt cannot fabricate
carrier landing completion.

## Limits and further work

The actual executable world remains a flat local fixture with the existing synthetic
GNSS origin and initial-north heading assumption. Its point parcel has no drag or
collision scene. The current power calculation is a declared ceiling budget, separate
from measured or modeled electrical consumption. Physical and authenticated-identity
flags remain false.

Distinct-vehicle fleet handover requires actual separate vehicle/boot/session sources,
fresh authority and custody observations, explicit transfer/acceptance and failure
behavior. It is not implemented by changing a scope label or copying a successful
summary. Durable cargo/runtime reconciliation, physical release/receiver validation and
the separate BVLOS operational evidence case remain issue #25 work. The
[cargo guide](../cargo-delivery.md) records the current command and library contracts.
