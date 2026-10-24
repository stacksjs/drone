# Drone library API

Import browser-safe functions from `resources/functions/drone/index.ts`. Import UDP and MAVLink
modules explicitly on the server; do not bundle `node:dgram` into stx client code.

## Behavior and decision

`follow({ distanceMeters, altitudeMeters, gain })` produces a heading-relative follow behavior.
`defineBehavior({ name, velocity(context) })` adds custom logic. The callback returns north/east/down
velocity in m/s. `decide({ telemetry, target, targetId, enabled, nowMs, behavior, limits? })` applies the
same checks to every behavior and returns `velocity`, `hold` or `release` with a reason.

Default limits: 80 m radius, 8-30 m altitude, 3 m/s horizontal, 1 m/s vertical, 5 m minimum separation,
25% battery reserve, 1,000 ms telemetry age, 1,500 ms target age, 4 m target accuracy, confidence 0.8,
and a two-second prediction horizon. These are development defaults, not measured airframe limits.

## Controller

```ts
import { createController, follow } from '../resources/functions/drone'

const controller = createController(adapter, follow({
  distanceMeters: 10, altitudeMeters: 12, gain: 0.5,
}), { targetId: 'paired-pilot' })

// At each trusted local control tick:
controller.setTarget(selectedTarget)
controller.enable(performance.now(), 500)
const decision = controller.tick(performance.now())

// On operator stop and process teardown:
controller.disable()
controller.close()
```

`enable()` requires a finite timestamp and a lease in (0, 5000] ms. The maximum is a bound on
forgetting a lease, not a guaranteed real-time deadline. Do not automatically renew from a timer
without independently checking operator authority. `close()` is idempotent. The SITL example has
a hard 30-second duration and a deliberately artificial target.

## Modeled cargo missions

The cargo modules expose the owned runtime directly, without an external-autopilot dependency:

- `planCargoDelivery(configuration)` in `resources/functions/drone/cargo/plan.ts` captures a
  complete declaration and validates the normal/alternate mission graph and declared reserve.
- `simulateCargoDelivery({ configuration, scenario? })` in `cargo/delivery.ts` under the same
  drone folder runs its actual loaded rigid body through the raw sensors, estimator, mission,
  controls, authority and watchdog. Omitting configuration selects only the closed named fixture.
- `cargoDeliverySummary(run)` produces a bounded compact projection, preserving actual mission,
  custody and host-loss outcomes. A matched failure demonstration is not delivery completion.
- `createCargoDeliveryCoordinator(declaration, modeledMechanism)` in `cargo/coordinator.ts`
  implements `VehiclePayloadPort`, captured readiness and idempotent cancellation. Its adapter
  contract is synchronous and explicitly modeled, with no built-in hardware I/O.

The [cargo guide](cargo-delivery.md) defines the flat synthetic origin, finite load/route bounds,
one-release and receipt semantics, phase-bound faults, native CLI exit codes and remaining
fleet/physical/BVLOS work. Budgets are declared power ceilings, not electrical measurements.

`createReceivingRigidBody({ expectedPointLoad, ...bodyOptions })` in `controls/physics.ts`
provides the separate [point-load intake prerequisite](cargo-delivery.md#point-load-intake-prerequisite).
It integrates real modeled mass/CG changes after one coincident inelastic point capture.
The caller still owns the parcel, finite station handling and captured fleet custody protocol.

`createCargoStationHandler(declaration)` in `cargo/station.ts` owns one existing point
through ballistic capture, finite rail transport, cancellation braking and a single
departure. See the [station model and integration limits](cargo-station.md). It does not
grant vehicle authority or confirm custody.

`simulateCargoFleet({ scenario? })` and `cargoFleetSummary(run)` in `cargo/fleet.ts`
execute [two-carrier handover](cargo-fleet.md) through actual retained source and receiver
runtimes, a consumed station parcel, current-authority intake and captured custody. The
eleven bounded fault cases retain incomplete outcomes and actual mass separately from receipts.
`createCargoFleetSession()` exposes exact-epoch `step`, detached `snapshot`/terminal `result`,
scoped `decide` and idempotent `close`, with the exported `CargoFleetOperatorDecision` type.
`simulateCargoFleetControl({ case? })` in `cargo/fleet-control.ts` supports four explicit
transport cancellation/recovery cases. The [operator contract](cargo-fleet.md#retained-world-and-explicit-transport-decisions)
retains current authority, a single physical point, original receive deadlines and
attempted-intake uncertainty. It does not restore a failed vehicle session.

`importLasSurface(bytes, declarationJson)` in `volumes/las.ts` produces a declared
cell-mean surface and separate point-selection/gridding audit. The [LAS contract](volumes-las.md)
describes profile limits, missing cells and unknown representation error. The server-only
`writeVolumeDataset(directory, request, { format: 'las', bytes, declarationJson })` verifies
that the retained original bytes/declaration reproduce the requested surface before publishing.

## Target sources

`createGpsTargetSource({ targetId, origin, maxSpeedMps?, now? })` converts trusted phone or GNSS fixes
to the fixed local frame. Its `update({ latitude, longitude, accuracyMeters, headingRadians })`
uses local receipt time, rejects impossible jumps and non-monotonic updates, and returns a `Target`.
Confidence 1 here means the caller supplied a paired source; it is not a statistical vision score.
Accuracy remains checked by `decide`. Authentication, pairing and upstream sample age belong to the
transport adapter; none is exposed as a public HTTP write endpoint in this release.

A future calibrated metric vision source must emit a stable explicitly selected target ID plus valid position,
heading, confidence, accuracy and local receipt time. A 2D bounding box alone is not such a source.

## Adapters

`FlightAdapter` exposes `kind`, `read()`, `send(decision)` and `close()`.
`createSimulator({ behavior? })` owns an ideal kinematic adapter, configurable settings and failure injection.
Pass a custom behavior here to drive motion over time; `step()` computes that behavior before advancing
physics. Its `adapter` is also available for isolated controller tests, but commands sent externally
are replaced by the configured behavior on the next `step()`.
`createUdpAdapter({ kind: 'telemetry-only' | 'sitl', listenPort, sitlPort?, systemId?, componentId? })`
uses loopback UDP. An optional `sitlPort` pins the expected peer; otherwise the first valid matching
ArduCopter heartbeat supplies its return port. Hardware receive mode cannot send commands.

`encodeVelocity()` produces a velocity-only SET_POSITION_TARGET_LOCAL_NED packet with mask 3527
and frame 1. It never encodes arm, takeoff or mode-change commands.

## Read-only HTTP API

`GET /api/drone/capabilities` returns the adapter names, coordinate frame, default limits and
`physicalFlightEnabled: false`. It is deliberately public metadata and has no actuator side effects.
Camera selection/source mutations are bearer-protected and never actuate a vehicle. No web flight-control mutation endpoints exist. The browser simulator state lives in its own tab.

## Camera and visual interlock

`createVisualTracker()` accepts timestamped `CameraFrame` detections. Select a candidate explicitly
with its frame sequence; `snapshot(nowMs)` expires stale locks and returns an image observation only
after continuity confirmation. Loss is latched until reselection. This is not a metric `Target`.

`createVisualLockGuard({ selectedLockId, read })` binds the lock to a controller's optional `guard`.
A lost, stale, unconfirmed or changed lock holds an otherwise valid velocity decision. Safety releases
retain precedence. The guard supplements an independently supplied position target.

The authenticated `/api/camera/state` and `/api/camera/command` Actions own the shared camera session.
Read [the camera guide](camera-tracking.md) for the command schema and process/clock contract.
ArduPilot and PX4 factories are server-only imports from `drone/drivers`; see [drivers](drivers.md).
