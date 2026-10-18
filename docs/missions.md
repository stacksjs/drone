# Owned mission engine

Issue #10 adds a versioned, simulator-only mission engine under `resources/functions/drone/missions/`.
It runs through the owned raw sensor feed, estimator, position/rate controls, authority supervisor
and independent modeled output watchdog. ArduPilot and PX4 are not required.

```sh
./buddy missions:validate examples/local-mission.json
./buddy missions:simulate --scenario nominal
./buddy missions:simulate --scenario recovery --output /tmp/new-mission-recording
./buddy missions:replay /tmp/new-mission-recording/mission.json --at-ms 6000
./buddy missions:checkpoint /tmp/new-mission-recording/mission.json --at-ms 4980 --output /tmp/new-mission-checkpoint
./buddy missions:recover /tmp/new-mission-checkpoint/mission.json /tmp/fresh-mission-observation.json --output /tmp/new-mission-recovery
```

Open `/missions` for native stx scenario execution and recorded state/task inspection. The scenarios
are operator scripts, not live aircraft controls. The standalone compiled CLI exposes the same
commands outside the checkout. `--plan` accepts a validated JSON plan; `--seconds` bounds virtual
execution and exits unsuccessfully if the expected terminal state was not reached.

## Version 1 plan and task semantics

The plan has an immutable ID, `version: 1`, explicit LOCAL_NED frame, fixed geodetic origin in
WGS84 ellipsoid metres, `ORIGIN_RELATIVE_DOWN` altitude and `FLAT_ORIGIN_PLANE` terrain.
Down is positive. Origin height is not terrain elevation or orthometric/MSL height. DEM following,
moving origins, geodetic waypoints and obstacle avoidance are rejected or remain unsupported.
The owned physics fixture uses origin 0,0,100; policy replay can use another explicit origin.

Graphs contain 2..32 uniquely identified tasks. They must be acyclic and entirely reachable from a
single initial takeoff. Edges must resolve and all paths terminate at land or abort. The version
covers these tasks:

| Task | Behavior |
| --- | --- |
| takeoff | Start only after explicit operator action, healthy matching estimator, retained autonomous authority, ground contact, sufficient battery and horizontal launch alignment |
| waypoint | Move the position target toward a fixed point at at most 0.6 m/s |
| loiter | Reach a fixed point and remain within acceptance continuously for the requested duration |
| return | Move to the explicitly planned rally point, without landing automatically |
| land | Target the origin terrain plane; require proximity, low estimated speed and modeled ground contact for 500 ms, then release and disarm in the fixture |
| payload | Emit one `camera-still` event identified by task ID; no hardware dispatch or image acquisition |
| branch | Select `then` or `otherwise` using the current observed battery percentage |
| abort | Release the mission immediately, with no implicit return or landing |

Movement acceptance is 0.2 m with speed below 0.3 m/s for 500 ms. Targets ramp along straight
segments; the cylinder and altitude interval are convex, so endpoint checks contain those segments.
Task timeouts are 1..20 seconds. Loiter duration must leave room in its timeout. The scheduler runs
at 20 ms in a 4 ms physics loop. A gap over 40 ms latches a blocked state. The physics model has a
10 cm landing gear clearance: the body contact plane is D=-0.1 m above terrain D=0. This prevents
an inconsistent body-origin touchdown while retaining the existing strict authority fence.

## Validation, budget and authority

The plan fence stays inside the authority supervisor's fixed envelope with a radial/ceiling margin.
Every point, including rally and landing targets, is validated. Rally must be airborne. Unknown
fields, versions, tasks, frames and terrain modes fail before execution. The conservative endurance
estimate uses the longest graph path, task timeouts and explicit hover power against available Wh,
with a reserve above the supervisor's 25 percent floor. This is a declared energy model, not measured
airframe power or proof a waypoint is dynamically reachable before timeout.

The running engine rechecks observed position, estimator health, origin, boot/reset identity,
battery reserve, elapsed endurance and authority on every observation. Time is one monotonic
fixture clock. Backward/duplicate or malformed observations fail closed. An authority takeover,
reference change or fault blocks execution with no automatic re-engagement.

The engine never arms itself. The fixture explicitly arms/engages at 600 ms and renews scoped
100 ms position-command leases through the existing supervisor. Every modeled motor output still
passes its output gate and independent board watchdog. Completion, cancellation or blocked execution
releases the target and the fixture disarms/revokes outputs. Aborting at altitude zeros modeled
thrust. It is not a controlled or emergency landing.

## Pause, checkpoints and recorded decisions

Pause captures a position hold, freezes task time and clears settling progress. It continues to
consume total time/energy and requires supervised authority and lease renewal. Resume is explicit.
A fault cannot be cleared by resume or a repeated start.

A checkpoint is a complete v1 mission-decision prefix, including plan, compact estimator observations,
actions and expected outputs. `recoverMission(trace, freshObservation)` recomputes every decision,
then enters paused state at the current estimated position. A recovery may cross a mission-process
scheduling gap, but cannot cross an origin/boot/reset change, loss of authority, reserve, fence or
total endurance limit. It requires an operator resume before task execution. This models a mission
process restart while the independent supervisor still retains supervised authority. It does not
restore controller integrals, a board session, a whole vehicle after power loss, or a payload ACK.
A real host loss is handled by the existing watchdog, not by automatic checkpoint continuation.

Trace replay recomputes branch choices, target ramps and event identities with no IO. Corrupt or
inconsistent decisions fail verification. Acyclic graphs and prefix replay preserve one event per
payload task on this pure in-process simulation. This is not exactly-once hardware delivery. JSON
traces are unsigned and can be rewritten consistently by an editor; replay consistency does not
authenticate observations. Limits are 6,001 rows and 8 MiB, with no overwrite or rotation. CLI output
uses a new private directory and exclusive 0600 file, followed by fsync. Torn JSON is rejected.
Mission traces contain synthetic local positions and must not be treated as the runtime-only,
location-free diagnostics v1 format.

### Portable mission-process checkpoints

For the synthetic recovery scenario above, create the explicit observation file from its recorded
6000 ms fixture epoch before running `missions:recover`:

```sh
bun -e 'const trace = await Bun.file("/tmp/new-mission-recording/mission.json").json(); const row = trace.rows.find(row => row.observation.nowMs === 6000); await Bun.write("/tmp/fresh-mission-observation.json", JSON.stringify(row.observation))'
```

This deliberately exercises recovery against recorded simulation data. A running simulation must
instead supply its current supervised observation.

`missions:checkpoint` verifies the entire source recording before extracting its active decision
prefix at an exact recorded observation epoch. Ready, completed, blocked and aborted prefixes are
not resumable. It writes a separate private `mission.json` without modifying the source. This also
allows extracting a running prefix from a completed simulation for a deliberate recovery exercise.

`missions:recover` reads that checkpoint and an explicit simulation `MissionObservation` JSON
file. The observation must come from the current modeled estimator and authority supervisor and
contain `kind`, `nowMs`, `reference`, `origin`, `healthy`, `positionM`, `velocityMps`, `authority`,
`batteryPercent` and `onGround`, as defined in `missions/engine.ts`. It must have a later monotonic
epoch, the same boot/reset reference and origin, healthy estimates, autonomous authority, a position
inside the fence, and remaining reserve/endurance. Invalid or stale inputs fail before creating the
output directory. Malformed JSON errors do not echo observation contents.

Successful recovery appends a replayable `recover` decision, saves it in a new private directory,
and reports `paused` with `checkpoint-recovered-awaiting-resume`. Neither command arms, resumes,
connects to a vehicle, nor restores another subsystem's state. A simulation caller may load the
recovered trace through `replayMission` and explicitly submit `resume` using its next fresh
supervised observation. File declarations are unsigned: checking `authority: autonomous` does not
authenticate a supervisor. This is a v1 owned quadcopter mission-process exercise, not durable
whole-runtime recovery or a command to restart a physical aircraft.

## Evidence and next work

The public API tests run actual owned physics for nominal, pause/resume, recovery, abort, RC override,
reserve and low-budget branch scenarios. They record and recompute the resulting traces, verify one
camera event after recovery, no event on the return branch, retained position holds, landed body
clearance and zero terminal board output. The CLI test persists a recovery trace and replays the
paused epoch. `/missions` is a Stacks scenario viewer over these same browser-compatible modules.

This is owned physics simulation, not native C++ board execution, external firmware SITL, HIL or
physical flight. The engine exposes position targets through the existing owned authority contract.
The external drivers' linear MAVLink mission-transfer contract stays separate: a reviewed graph
compiler and frame/capability translation are still needed before a shared driver can execute it.

Issue #10 remains open for durable correlated whole-runtime checkpoints, payload transaction/ACK
reconciliation, external driver translation, richer energy/terrain/rally planning and restart/HIL
failure evidence. Hardware acceptance, real landing detection, obstacle-aware return and physical
mission control remain separate gates. See [ADR 10](adr/0010-owned-missions.md).
