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
./buddy missions:resume /tmp/new-mission-recovery/mission.json /tmp/next-mission-observation.json --output /tmp/new-mission-resume
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
supervised observation, or use `missions:resume` as described below. File declarations are unsigned: checking `authority: autonomous` does not
authenticate a supervisor. This is a v1 owned quadcopter mission-process exercise, not durable
whole-runtime recovery or a command to restart a physical aircraft.

### Explicit portable resume

`missions:resume <checkpoint> <observation> --output <new-directory>` accepts a verified paused
v1 mission trace and the next explicit supervised simulation observation. It replays the entire
prefix, checks authority, estimator health, reference, origin, fence, reserve and endurance through
the same engine, then appends one operator `resume` decision. A duplicate or backward clock is
invalid; a gap over 40 ms blocks resume. After a longer mission-process outage, run
`missions:recover` with the current observation first, then resume at the next fresh epoch.
Running, ready and terminal traces are rejected rather than treated as implicit recovery.

For the recorded simulation exercise above, extract its 6020 ms observation:

```sh
bun -e 'const trace = await Bun.file("/tmp/new-mission-recording/mission.json").json(); const row = trace.rows.find(row => row.observation.nowMs === 6020); await Bun.write("/tmp/next-mission-observation.json", JSON.stringify(row.observation))'
./buddy missions:resume /tmp/new-mission-recovery/mission.json /tmp/next-mission-observation.json --output /tmp/new-mission-resume
./buddy missions:replay /tmp/new-mission-resume/mission.json
```

The result is a separate private replayable trace. Its state is `running`, or `aborted` if resuming
executes a planned abort task immediately; that legitimate terminal decision releases the target.
The source is preserved,
existing output directories are rejected, and rejected inputs create no output directory. A
simulation caller can continue stepping the returned `resumeMission` engine with current owned
runtime observations. The CLI records a single mission-policy decision; it does not keep a
vehicle loop alive, restore a whole runtime, arm hardware or execute a physical payload. Retained
payload identities prevent duplicate pure-policy events in the continued trace, without claiming
exactly-once physical delivery. These unsigned files do not authenticate a supervisor.

## Portable version 2 vehicle missions

The same native commands now accept v2 fixed-wing, ground, surface and subsea traces.
Generate a private recording with the owned profile runtime:

```sh
./buddy missions:simulate --profile ground --scenario logistics --seconds 120 --output /tmp/new-ground-mission
./buddy missions:replay /tmp/new-ground-mission/mission.json
```

`--profile` defaults to `quadcopter`, retaining the v1 behavior and optional `--plan`.
Other profiles use their reviewed built-in plans and reject `--plan`. Omitted duration is
45 seconds for quadcopters and 120 seconds for other profiles. A bounded run that fails to
reach its scenario's expected outcome exits unsuccessfully, even if it saves a diagnostic trace.
Profile scenario lists are available through `air:simulate`, `ground:simulate`,
`surface:simulate` and `subsea:simulate` help.

`missions:checkpoint`, `missions:recover`, `missions:resume` and `missions:replay` dispatch
by explicit trace version. V1 retains its 8 MiB / 6,001-row budget; v2 retains
16 MiB / 9,001 rows. Playback verifies the entire source before selecting an earlier epoch.
V2 checkpoint extraction requires an exact active epoch without a pending payload command.
A source containing later corrupt decisions is rejected even when extracting an earlier prefix.

Use the same observation-file workflow described above for recovery and resume, with the
matching v2 observation schema in `vehicles/types.ts`, including explicit `payloadAck: null`
when there is no acknowledgement. Recovery still enters paused state. Resume requires the
next fresh compatible supervised observation within 40 ms; a longer outage requires recovery
first. Reference changes, lost authority, estimator loss, fence breach, insufficient reserve,
endurance exhaustion and unsolicited or malformed acknowledgements refuse publication.
An immediate planned abort or completed stop/landing is retained as a valid terminal decision
with its target released. Terminal, ready and running traces cannot be implicitly resumed.

The public policy APIs are `checkpointVehicleMission`, `recoverVehicleMission` and
`resumeVehicleMission`. Version-aware recording helpers live in `missions/recording.ts`.
Private exclusive writes validate either trace version before creating an output directory,
preserve the source and refuse overwrite. A pending or uncertain payload is never retried
by portable recovery. Confirmed modeled acknowledgements and event identities remain in the
verified prefix. These are unsigned mission-process artifacts: they neither authenticate the
observation provider nor restore a complete vehicle runtime, board or physical payload state.

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
