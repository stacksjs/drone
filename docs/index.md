# Drone

Build custom vehicle autonomy with an owned runtime, sensor pipeline, estimator,
controls and mission engine. Drone is a Stacks application with TypeScript library
functions in `resources/functions/drone/`, native Buddy commands and stx workspaces.
ArduPilot and PX4 are optional drivers.

Use the sidebar to read guides here. Inline guide links open their GitHub source.
Routing for relative Markdown links is tracked in [issue #39](https://github.com/stacksjs/drone/issues/39).

**Current status: experimental simulation and bench development. Physical telemetry
is receive-only and physical flight commands are disabled.** Modeled completion,
protocol tests and synthetic datasets do not establish physical flight, measured
survey accuracy or a field-qualified service.

## Start locally

Use Bun 1.4.2 or newer and the repository's frozen lockfile:

```sh
git clone https://github.com/stacksjs/drone.git
cd drone
bun install --frozen-lockfile
cp .env.example .env
./buddy key:generate
./buddy dev
```

Open the frontend URL printed by Buddy. The home simulator runs locally in the
browser and has no aircraft connection. For a terminal demonstration:

```sh
./buddy drone:simulate
```

Read [architecture and failure behavior](https://github.com/stacksjs/drone/blob/main/docs/architecture.md) before extending control.
For your Pi 5, start with the [hardware list](https://github.com/stacksjs/drone/blob/main/docs/hardware.md),
[Pi bring-up](https://github.com/stacksjs/drone/blob/main/docs/raspberry-pi.md) and [Pi AI Camera tracking](https://github.com/stacksjs/drone/blob/main/docs/camera-tracking.md).
An image-space person lock does not establish identity or metric position.

## Build on our runtime

The [native bench runtime](https://github.com/stacksjs/drone/blob/main/docs/runtime.md) has host and Pico 2 build paths. Its board
profile remains neutral-only. The owned [sensor pipeline](https://github.com/stacksjs/drone/blob/main/docs/sensors.md),
[estimator](https://github.com/stacksjs/drone/blob/main/docs/estimation.md), [multirotor controls](https://github.com/stacksjs/drone/blob/main/docs/controls.md),
[authority supervisor](https://github.com/stacksjs/drone/blob/main/docs/authority.md), [mission engine](https://github.com/stacksjs/drone/blob/main/docs/missions.md) and
[navigation](https://github.com/stacksjs/drone/blob/main/docs/navigation.md) have separate simulation and hardware acceptance gates.

[Diagnostics and replay](https://github.com/stacksjs/drone/blob/main/docs/diagnostics.md) retain explicit loss and provenance.
The [library API](https://github.com/stacksjs/drone/blob/main/docs/api.md) describes behavior extensions. The
[shared vehicle contract](https://github.com/stacksjs/drone/blob/main/docs/vehicles.md) covers quadcopter, fixed-wing, ground,
surface and subsea profiles. [Optional external drivers](https://github.com/stacksjs/drone/blob/main/docs/drivers.md) have
[acknowledged protocol services](https://github.com/stacksjs/drone/blob/main/docs/driver-protocols.md); scripted peers are distinct
from [firmware SITL](https://github.com/stacksjs/drone/blob/main/docs/sitl.md) and physical testing.

## Explore a workflow

| Workflow | Current development surface | Guide |
|---|---|---|
| Camera tracking and follow | Explicit target selection, image-space loss handling and synthetic calibrated fusion | [Tracking](https://github.com/stacksjs/drone/blob/main/docs/camera-tracking.md), [fusion](https://github.com/stacksjs/drone/blob/main/docs/vision.md) |
| Aerial mapping | Survey planning, synthetic acknowledged capture and dataset export; reconstruction remains open | [Survey collection](https://github.com/stacksjs/drone/blob/main/docs/mapping.md) |
| Stockpile volumes | Numeric grids/TINs, declared base surfaces, cut/fill and uncertainty; acquisition accuracy is separate | [Volume processing](https://github.com/stacksjs/drone/blob/main/docs/volumes.md) |
| Infrastructure inspection | Asset-relative modeled capture, explicit observations and repeat-visit comparison | [Inspection](https://github.com/stacksjs/drone/blob/main/docs/inspection.md) |
| Farming | Synthetic crop sensing and declared planning previews; agronomy and authenticated app integration remain separate | [Agriculture](https://github.com/stacksjs/drone/blob/main/docs/agriculture.md), [Open Farming](https://github.com/stacksjs/drone/blob/main/docs/open-farming.md) |
| Prescribed application | Owned ground simulation for inert water or granules, with explicit implement authority | [Application](https://github.com/stacksjs/drone/blob/main/docs/application.md) |
| Public safety | Synthetic incident collection, authenticated records, review and local dataset management | [Public safety](https://github.com/stacksjs/drone/blob/main/docs/public-safety.md) |
| Patrol and docking | Retained modeled vehicle, explicit decisions, finite recurrence and charge opt-in | [Patrol CLI](https://github.com/stacksjs/drone/blob/main/docs/patrol-cli.md) |
| Cargo and cinema | Bounded carried-load characterization and a simulated POI angular reframe | [Cargo](https://github.com/stacksjs/drone/blob/main/docs/cargo-load.md), [cinema](https://github.com/stacksjs/drone/blob/main/docs/cinema.md) |
| Environmental sampling and antenna pointing | Synthetic sampling and a selected-vehicle mount model | [Environment](https://github.com/stacksjs/drone/blob/main/docs/environment.md), [antenna](https://github.com/stacksjs/drone/blob/main/docs/antenna.md) |

Each guide distinguishes implemented behavior, recorded evidence and remaining
work. The sidebar links the detailed runtime, vehicle, payload and operational
record contracts.

## Follow implementation and evidence

The [dependency roadmap](https://github.com/stacksjs/drone/blob/main/docs/roadmap/README.md) and
[feature coverage matrix](https://github.com/stacksjs/drone/blob/main/docs/roadmap/feature-coverage.md) map the requested workflows
to issues. The [behavior parity audit](https://github.com/stacksjs/drone/blob/main/docs/parity.md) records reviewed upstream scope
and unresolved detail; inventory coverage is not full ArduPilot or PX4 parity.
The [validation record](https://github.com/stacksjs/drone/blob/main/docs/validation.md) describes individual tested slices and
their limits.

Physical integrations retain independent flight-controller and RC authority.
Read the [flight-development gates](https://github.com/stacksjs/drone/blob/main/docs/flight-development.md) before connecting
hardware. Follow work in the [public repository](https://github.com/stacksjs/drone)
and [issue tracker](https://github.com/stacksjs/drone/issues).
