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

## Target sources

`createGpsTargetSource({ targetId, origin, maxSpeedMps?, now? })` converts trusted phone or GNSS fixes
to the fixed local frame. Its `update({ latitude, longitude, accuracyMeters, headingRadians })`
uses local receipt time, rejects impossible jumps and non-monotonic updates, and returns a `Target`.
Confidence 1 here means the caller supplied a paired source; it is not a statistical vision score.
Accuracy remains checked by `decide`. Authentication, pairing and upstream sample age belong to the
transport adapter; none is exposed as a public HTTP write endpoint in this release.

A future vision source must emit a stable explicitly selected target ID plus valid position,
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
No web flight-control mutation endpoints exist. The browser simulator state lives in its own tab.
