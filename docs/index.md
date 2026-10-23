# Drone

Build custom vehicle autonomy with an owned runtime, sensor pipeline, estimator,
controls and mission engine. Drone is a Stacks application with TypeScript library
functions in `resources/functions/drone/`, native Buddy commands and stx workspaces.
ArduPilot and PX4 are optional drivers.

Use the sidebar or inline links to read guides here. Markdown source links also work
when browsing the repository on GitHub.

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

Read [architecture and failure behavior](architecture.md) before extending control.
For your Pi 5, start with the [hardware list](hardware.md),
[Pi bring-up](raspberry-pi.md) and [Pi AI Camera tracking](camera-tracking.md).
An image-space person lock does not establish identity or metric position.

## Build on our runtime

The [native bench runtime](runtime.md) has host and Pico 2 build paths. Its board
profile remains neutral-only. The owned [sensor pipeline](sensors.md),
[estimator](estimation.md), [multirotor controls](controls.md),
[authority supervisor](authority.md), [mission engine](missions.md) and
[navigation](navigation.md) have separate simulation and hardware acceptance gates.

[Diagnostics and replay](diagnostics.md) retain explicit loss and provenance.
[Runtime trust and image staging](runtime-updates.md) preserves enrolled trust,
journals verified metadata and prepares owned image candidates. Physical board
installation, persistent boot selection and recovery require separate qualification.
The [library API](api.md) describes behavior extensions. The
[shared vehicle contract](vehicles.md) covers quadcopter, fixed-wing, ground,
surface and subsea profiles. [Optional external drivers](drivers.md) have
[acknowledged protocol services](driver-protocols.md); scripted peers are distinct
from [firmware SITL](sitl.md) and physical testing.

The separate [VTOL hover development command](vehicles-vtol.md) exercises vertical takeoff,
hover and landing. Front/cruise/back transitions and the common VTOL mission workspace remain open.

## Explore a workflow

| Workflow | Current development surface | Guide |
|---|---|---|
| Camera tracking and follow | Explicit target selection, image-space loss handling and synthetic calibrated fusion | [Tracking](camera-tracking.md), [fusion](vision.md) |
| Aerial mapping | Survey planning, synthetic acknowledged capture and dataset export; reconstruction remains open | [Survey collection](mapping.md) |
| Stockpile volumes | Numeric grids/TINs, declared base surfaces, cut/fill and uncertainty; acquisition accuracy is separate | [Volume processing](volumes.md) |
| Infrastructure inspection | Asset-relative modeled capture, explicit observations and repeat-visit comparison | [Inspection](inspection.md) |
| Farming | Synthetic crop sensing and declared planning previews; agronomy and authenticated app integration remain separate | [Agriculture](agriculture.md), [Open Farming](open-farming.md) |
| Prescribed application | Owned ground simulation for inert water or granules, with explicit implement authority | [Application](application.md) |
| Public safety | Synthetic incident collection, authenticated records, review and local dataset management | [Public safety](public-safety.md) |
| Patrol and docking | Retained modeled vehicle, explicit decisions, finite recurrence and charge opt-in | [Patrol CLI](patrol-cli.md) |
| Cargo and cinema | Bounded carried-load characterization and a simulated POI angular reframe | [Cargo](cargo-load.md), [cinema](cinema.md) |
| Environmental sampling and antenna pointing | Synthetic sampling and a selected-vehicle mount model | [Environment](environment.md), [antenna](antenna.md) |

Each guide distinguishes implemented behavior, recorded evidence and remaining
work. The sidebar links the detailed runtime, vehicle, payload and operational
record contracts.

## Follow implementation and evidence

The [dependency roadmap](roadmap/README.md) and
[feature coverage matrix](roadmap/feature-coverage.md) map the requested workflows
to issues. The [behavior parity audit](parity.md) records reviewed upstream scope
and unresolved detail; inventory coverage is not full ArduPilot or PX4 parity.
The [validation record](validation.md) describes individual tested slices and
their limits.

Physical integrations retain independent flight-controller and RC authority.
Read the [flight-development gates](flight-development.md) before connecting
hardware. Follow work in the [public repository](https://github.com/stacksjs/drone)
and [issue tracker](https://github.com/stacksjs/drone/issues).
