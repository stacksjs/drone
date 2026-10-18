# Drone

A Stacks project for building your own drone companion software in TypeScript.
Start with a simulator, write custom behavior, and receive telemetry on a Raspberry Pi 5.

**Status: experimental, simulation and bench development. Physical flight commands are disabled.**
The MAVLink command adapter is for local ArduCopter SITL only. No hardware flight test or full SITL flight has been performed for this release. This is an initial framework, not a finished autonomous aircraft.

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

## Where your code goes

| Path | Responsibility |
| --- | --- |
| `resources/functions/drone/` | Public drone library: types, behaviors, target sources, safety, controllers, simulation |
| `resources/functions/drone/mavlink.ts` | Small verified MAVLink v1/v2 common-message codec |
| `resources/functions/drone/udp.ts` | Bun UDP adapter, imported explicitly on the server only |
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

The recommended split is your own Stacks application on the Pi plus ArduCopter on a dedicated
Pixhawk. You own the follow logic, behavior extensions, simulation, UI and integration code.
This does not claim that flight-controller firmware, radio firmware, camera firmware, or board designs
were authored here. Replacing the flight stack or designing PCBs is a separate project.

## Current boundaries

- Implemented: kinematic follow simulation, configurable envelope, custom behavior hooks,
  monotonic freshness and lease checks, target identity lock, GPS-fix normalization with jump
  rejection, verified MAVLink subset, local UDP receive/transmit tests, receive-only Pi telemetry.
- Hardware control is receive-only. No arming, takeoff, mode switching, motor output, or RTL command is implemented.
- SITL commands require the separate explicit runner. Loopback is an accidental-use guard, not a
  security boundary against another local process or a router forwarding to a physical vehicle.
- No camera acquisition, neural-network inference, person re-identification, obstacle avoidance,
  terrain following, automatic phone pairing, camera streaming, or flight-log persistence yet.
- Software envelope prediction assumes immediate ideal velocity response and a stationary target over
  its horizon. It does not model braking, wind, sensor error, moving obstacles, or aircraft dynamics.
- A camera detecting a person does not establish who that person is or their GPS distance.
  First integrate an explicitly paired GNSS/phone target feed, then add vision as a separate source.

Read [architecture and failure behavior](docs/architecture.md), [validation evidence](docs/validation.md),
and the [flight-development checklist](docs/flight-development.md) before extending control.

MIT. Maintained by Chris Breuer.
