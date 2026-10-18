# Drone

A Stacks project for an owned vehicle autonomy platform. Build custom TypeScript behaviors,
track a selected person with a Pi AI Camera, and use ArduPilot or PX4 as optional drivers while
we implement our own runtime, estimation, controls and mission engine.

**Status: experimental, simulation and bench development. Physical flight commands are disabled.**
The MAVLink command adapters are for local ArduCopter/PX4 quadcopter SITL only. No hardware flight test or full SITL flight has been performed for this release. This is an initial framework, not a finished autonomous aircraft.

## Run it

Requires Bun >= 1.4.2. The owner has a Raspberry Pi 5 with 8 GB RAM.

```sh
bun install --frozen-lockfile
cp .env.example .env
./buddy key:generate
./buddy dev
```

Open the frontend URL printed by Buddy. Run simulation, change following distance and altitude,
then inject target loss or low battery. The browser simulation is local to each tab and has no
connection to an aircraft. It deliberately pauses time when the tab is hidden.

```sh
bun run simulate        # deterministic terminal demo, no hardware
./buddy drone:simulate  # the same library through a native Stacks command
bun run telemetry       # receive-only MAVLink endpoint on 127.0.0.1:14551
bun run sitl --enable-sitl # 30-second local simulator experiment; read docs/sitl.md first
./buddy lint
./buddy typecheck
./buddy test
```

## Camera tracking

Open `/camera` after configuring a unique `DRONE_CAMERA_TOKEN` in your ignored `.env`. Choose
replay for a hardware-free test, or Pi AI Camera on the Pi. Explicit selection confirms a visual
lock; ambiguity, stale inference and lost detections invalidate it until reselection.
See [camera setup and limits](docs/camera-tracking.md). Image-space tracking is not metric navigation.

## Camera and payload adapters

Issue #8 adds an owned Pi AI Camera still adapter, bounded command/ACK and clock synchronization,
image manifests, estimator-pose association and typed bus contracts. Physical camera calibration
and execution remain unvalidated; other payload device drivers remain planned.

```sh
./buddy payloads:bench
./buddy payloads:bench --scenario lost-ack
./buddy payloads:capture --driver replay --output /tmp/new-drone-capture
```

See [payload acquisition, Pi commands and acceptance gates](docs/payloads.md). A standalone physical
capture has no live pose feed and reports unavailable association. No output claims georeferencing.

## Owned runtime and CLI

The first native kernel now builds for a host harness and a Pico 2 development board. It provides
synthetic timestamped samples, bounded scheduling/protocol state and a neutral-only GPIO profile.
Board timing, stack and watchdog-reset measurements remain open in issue #2.

```sh
./buddy runtime:bench --ticks 1000
./buddy runtime:bench --fault deadline
./buddy runtime:build --target pico2 --sdk /path/to/pico-sdk
bun run runtime:cli
./storage/runtime-build/cli/drone --help
```

Read the [runtime build and bench guide](docs/runtime.md) and [wire contract](docs/runtime-protocol.md).
The standalone CLI uses the same native Stacks command definitions as Buddy. Runtime commands do
not flash hardware; physical camera acquisition requires an explicit `--driver imx500`. Keep your Pi 5 for Stacks mission/camera logic; the Pico 2 is a separate bench board.

## Sensor acquisition and replay

Issue #3 adds a separate Pico 2 sensor image for ICM-42688-P, BMP280 and u-blox NAV-PVT,
plus SI conversion, calibration profiles, independent freshness/quality checks and simulator replay.
The retained dataset is synthetic. Physical capture, calibration and timing evidence remain open.

```sh
./buddy sensors:replay tests/fixtures/sensors/bench-v1.json --at-ms 500
./buddy sensors:inspect /tmp/sensors-uart.bin
./buddy runtime:build --target pico2 --sensors --sdk /path/to/pico-sdk
```

See the [sensor wiring, calibration and clock guide](docs/sensors.md). Sensor replay is diagnostic;
the owned estimator below consumes it separately from flight control telemetry.

## Owned estimator

Issue #4 adds gyro/gravity tilt, GNSS position/velocity in a fixed NED frame, separate
pressure-relative height and explicit health/reset reporting. Absolute heading remains unavailable.

```sh
./buddy estimator:replay tests/fixtures/estimation/motion-v1.json --at-ms 6040
```

Read the [estimator guide and remaining work](docs/estimation.md). Replay uses every sensor event;
this Pi-side bench estimator is separate from ideal simulator control telemetry. Physical estimator
validation and a tightly coupled inertial EKF remain open.

## Simulated owned multirotor controls

Issue #5 adds bounded position, velocity, attitude and rate loops with quad-X allocation in a
rigid-body physics harness. It uses raw modeled sensors and our estimator, with an explicitly
assumed initial heading. Physical commands remain disabled.

```sh
./buddy controls:simulate --scenario step --seconds 20
./buddy controls:simulate --scenario wind --seconds 20
```

See the [control equations, simulation assumptions and remaining work](docs/controls.md).

## Simulated authority and failsafes

Issue #6 adds explicit arming/engagement, RC takeover, scoped command leases, latched faults
and an independent modeled output watchdog on the owned control harness.

```sh
./buddy authority:simulate --scenario nominal --seconds 20
./buddy authority:simulate --scenario pi-loss --seconds 8
```

See the [state machine, failure policies and hardware completion gates](docs/authority.md).
Physical kill/RC wiring and HIL validation remain open. Zero simulated thrust is not a landing.

## External-driver protocol services

Issue #7 adds shared acknowledged commands, parameter read/write, mission upload/download/resume
and optional strict MAVLink 2 signing behind both driver factories. Physical writes remain disabled.

```sh
./buddy drivers:bench --driver ardupilot --drop-first-ack
./buddy drivers:bench --driver px4 --signed --drop-first-ack
```

See the [protocol contract and remaining firmware SITL gates](docs/driver-protocols.md).
These commands use scripted UDP peers, with no autopilot firmware or flight simulated.

## Owned autopilot and roadmap

The [dependency-linked roadmap](docs/roadmap/README.md) and [feature matrix](docs/roadmap/feature-coverage.md)
cover the requested air, ground, surface, subsea, payload and industry workflows. A pinned inventory
accounts for 274 top-level upstream module/driver/library entries. The first native bench firmware is implemented; hardware validation and detailed
feature parity remain open, with explicit issues and evidence gates.
See [the ownership decision](docs/adr/0001-owned-autonomy.md) and [driver contract](docs/drivers.md).

## Where your code goes

| Path | Responsibility |
| --- | --- |
| `resources/functions/drone/` | Public drone library: types, behaviors, target sources, safety, controllers, simulation |
| `resources/functions/drone/mavlink.ts` | Small verified MAVLink v1/v2 common-message codec |
| `resources/functions/drone/udp.ts` | Bun UDP adapter, imported explicitly on the server only |
| `resources/functions/drone/camera/` | TypeScript tracker, session, API and a small Picamera2 acquisition helper |
| `resources/functions/drone/controls/` | Simulated cascaded multirotor control, quad-X allocation, physics and modeled sensors |
| `resources/functions/drone/estimation/` | Owned tilt, GNSS local-position filter, pressure height, health and replay |
| `resources/functions/drone/sensors/` | Typed sensor stream, calibration, clocks, health and capture/replay |
| `resources/functions/drone/drivers/` | Explicit ArduPilot/PX4 factories and mode profiles |
| `resources/components/` | Reusable stx simulator, operating-envelope and hardware components |
| `resources/views/index.stx` | Mission workspace |
| `app/Commands/Simulate.ts` | Native Buddy command |
| `app/Actions/DroneStatus.ts` | Read-only capabilities Action |
| `routes/api.ts` | Typed `GET /api/drone/capabilities` route |
| `examples/custom-behavior.ts` | Example extension point |
| `tests/` | Behavioral, controller-lifecycle and protocol tests |

The application uses published Stacks packages, stx templates, and ts-css utility styling.
The scaffold's retained `storage/framework/defaults/` files are framework defaults, not drone logic.
No database is needed for the transient simulator. Add a native Stacks model and model-derived
migration when adding persisted aircraft profiles or flight records.

## Write a behavior

```ts
import { defineBehavior } from './resources/functions/drone'

const stayNorth = defineBehavior({
  name: 'stay-north',
  velocity: ({ telemetry, target }) => ({
    north: (target.position.north + 12 - telemetry.position.north) * 0.5,
    east: (target.position.east - telemetry.position.east) * 0.5,
    down: (-12 - telemetry.position.down) * 0.5,
  }),
})
```

Use `createSimulator({ behavior: stayNorth })` to test its motion, or pass it to
`createController(adapter, stayNorth, { targetId: 'pilot' })`, feed the
selected target, and explicitly renew a short autonomy lease. See [the API](docs/api.md).
Every requested velocity passes through `decide()`. Custom behavior is trusted synchronous code;
run untrusted code outside the flight process.

## Build the aircraft

Buy the [parts list](docs/hardware.md) around the Pi you already own, then follow
[the Pi bring-up guide](docs/raspberry-pi.md). Budget approximately **$1,100-1,350 before tax and shipping**
for a complete starter bench and airframe, with local Remote ID requirements budgeted separately.
Prices are estimates except where explicitly marked as observed listings.

The current development split is the Stacks application on the Pi plus your chosen external
autopilot on a dedicated Pixhawk. The accepted direction is to replace those firmware layers with
our own implementation through the roadmap. You own the follow logic, behavior extensions, simulation, UI and integration code.
This does not claim that flight-controller firmware, radio firmware, camera firmware, or board designs
were authored here. The owned flight stack is planned in this repository; custom PCB design is not implemented.

## Current boundaries

- Implemented: kinematic follow simulation, configurable envelope, custom behavior hooks,
  monotonic freshness and lease checks, target identity lock, GPS-fix normalization with jump
  rejection, verified MAVLink subset, local UDP receive/transmit tests, receive-only Pi telemetry.
- Hardware control is receive-only. No arming, takeoff, mode switching, motor output, or RTL command is implemented.
- SITL commands require the separate explicit runners; `bun run sitl:px4 --enable-sitl` selects PX4. Loopback is an accidental-use guard, not a
  security boundary against another local process or a router forwarding to a physical vehicle.
- Implemented camera path: Picamera2 IMX500 acquisition/inference extraction, bounded JPEG preview,
  TypeScript selected-person association, explicit loss/reselection and an optional visual motion guard.
  The Pi hardware validation is pending. No metric visual localization, person re-identification,
  obstacle avoidance, terrain following, automatic phone pairing, or flight-log persistence yet.
- Software envelope prediction assumes immediate ideal velocity response and a stationary target over
  its horizon. It does not model braking, wind, sensor error, moving obstacles, or aircraft dynamics.
- A camera detecting a person does not establish who that person is or their GPS distance.
  First integrate an explicitly paired GNSS/phone target feed, then add calibrated visual/range fusion. The current 2D image observation stays separate.

Read [architecture and failure behavior](docs/architecture.md), [validation evidence](docs/validation.md),
and the [flight-development checklist](docs/flight-development.md) before extending control.

MIT. Maintained by Chris Breuer.
