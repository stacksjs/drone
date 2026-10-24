# Owned vehicle runtime

The fixed-wing, VTOL, ground, surface and subsea profiles execute through one owned raw sensor, estimator,
mission, authority and independent modeled board loop. The existing v1 quadcopter mission remains
compatible. The new v2 graph explicitly declares a vehicle, arrival speed and settling conditions,
contact-gated land/stop, scoped payload commands and longest-path energy/time budgets.

`resources/functions/drone/vehicles/` contains the domain library. Native `defineCommand` commands
in `app/Commands/` run the same public functions in Buddy and the compiled CLI. The stx `/missions`
workspace uses a presentation adapter over recorded decisions, with estimated positions and
correlated payload acknowledgements. It never supplies policy inputs or physical control.

## Execution ownership

A profile declares its mission, actuator units/ranges/neutrals, fence and fault fixtures. Each
`createSession()` allocates a fresh paired plant, controller, payload port and measurement renderer.
A reused profile can run independent sessions without sharing encoder sequences, implement flags,
consumed containers or closed ports. Close a session's port at teardown; a closed port stays closed.
The standalone plant/controller constructors remain available for focused physics experiments.

The simulation integrates model dynamics every 4 ms, renders bounded delayed vehicle measurements
and runs policy every 20 ms. Common IMU observations enter the existing sensor pipeline and estimator. Air, ground and surface
profiles also use GNSS. Underwater GNSS is disabled: qualified pressure and bottom-locked DVL
measurements provide owned local dead reckoning from an explicit stationary surface alignment.
The subsea datum is LOCAL_WATER_SURFACE, never a disguised underwater GNSS fix. Runtime source
counts retain whether raw GNSS observations were seen. Vehicle controllers see estimated pose and qualified measurements, never plant truth.
The initial north heading is a simulation assumption. Absolute heading and physical calibration
remain unqualified. Model truth is retained only for error evaluation.

Typed actuator declarations support signed wheels, aerodynamic surfaces and vessel thrust without
pretending those are quad motors. The common authority lifecycle gates them with explicit operator
arming/engagement. Independent board leases expire to each declared neutral, including the ground
and air spring/wheel brake channels. Neutral does not imply a vehicle has physically stopped.
Host loss leaves a stale host mission snapshot; the independently ticking board still expires output.

## Shared-clock modeled sessions

`createVehicleSimulationSession(profile, options)` in `vehicles/runtime.ts` retains the same
owned loop behind `step(atMs)`, `result()` and `close()`. Start at zero and advance exactly
4 ms per call. Two sessions can therefore be advanced at each shared epoch before the
coordinator evaluates their observations. Rejected duplicate, skipped or invalid epochs
do not advance the session; a caller can supply the expected epoch afterward.

An optional `scope: { bootId, sessionId }` captures two nonzero unsigned 64-bit bigints
before session resources open. The boot identity is encoded in the actual synthetic IMU/GNSS
packets, sensor clock anchor and estimator reference. Both identifiers also scope the
authority supervisor and independent board. They are correlations, not authentication.
Omitting scope preserves the original boot 55/session 123 reports.

```ts
const a = createVehicleSimulationSession(profileA, {
  seconds: 120, scope: { bootId: 101n, sessionId: 201n },
})
const b = createVehicleSimulationSession(profileB, {
  seconds: 120, scope: { bootId: 102n, sessionId: 202n },
})
try {
  // Advance each live session once at every epoch; stop stepping one after terminal.
  for (let atMs = 0, doneA = false, doneB = false; !doneA || !doneB; atMs += 4) {
    if (!doneA) doneA = a.step(atMs).terminal
    if (!doneB) doneB = b.step(atMs).terminal
  }
  console.log(a.result().status, b.result().status)
}
finally { a.close(); b.close() }
```

A tick returns detached mission, authority and board snapshots, the estimator reference,
its actual epoch, phase, terminal flag and last completed host policy epoch. Policy still
runs every 20 ms after alignment. During host loss or an opt-in independent settling tail,
`policyAtMs` does not advance. Tail epochs run only board/plant work. Host authority and
mission snapshots can remain stale; the board snapshot reflects its actual independent lease.

`result()` refuses an active session and returns a detached terminal report. Explicit
`close()` is idempotent: it closes owned payload state once, immediately revokes the modeled
board and reports a blocked `simulation-session-closed` outcome. It does not invent mission
completion, execute a recovery or settle the physical plant. A step failure also closes
ownership and revokes output before throwing; a simultaneous cleanup failure is retained
in an aggregate error. Naturally terminated sessions keep their existing terminal result.
Closing from an adapter callback stops the in-flight step before another adapter or output
acceptance runs. Recursive stepping is refused. An interrupted policy epoch is not reported
as completed, and terminal sessions report `hostAvailable: false`.
All adapter data results, including faults, plant state, navigation, measurements, payload
acknowledgements and controller output, are captured inside that ownership check before use.
A link callback that closes the session and then fails cannot hide the failure as a disconnected
observation. Void observation/request callbacks keep their ignored-return contract.
The initial plant snapshot and adapter method references are captured before the session
is exposed. Replacing a method property afterward does not replace the retained adapter;
modeled world changes belong in the adapter's own captured state.
`runVehicleSimulation` now drains this same interface to natural termination.

This enables concurrent modeled vehicle execution. It does not yet implement fleet custody
transfer, collision avoidance, a network scheduler, distributed clocks or physical multi-vehicle
control. Callers must avoid reusing identities. [Cargo issue #25](cargo-delivery.md#remaining-issue-scope)
remains open for the actual handover policy and evidence.

## Payload and survey evidence

Payload requests bind event, task, operation, container, reference, position and an expiry window.
Modeled acknowledgements preserve capture time separately from delivery. An uncertain or missing
result blocks progression and is never automatically retried as a new action. Recovery during a
pending action also blocks. These identities do not establish exactly-once delivery on hardware.

The opt-in quadcopter `material-receive` task adds a declared pad anchor and a bounded
wait for one correlated receipt. It enters with inhibited motor commands under qualified
surface contact. Its [interlocks and counted failure routes](cargo-delivery.md#receiving-mission-task-prerequisite)
are distinct from the still-pending mechanical-intake and fleet custody coordinator.

Surface sounding reduction retains raw acoustic corrections, local datum, capture-pose estimator
and gyro epochs and declared position/attitude/clock uncertainty. It projects the beam footprint and
rejects unqualified capture timing or uncertainty below the sensor declaration. This is a modeled
single-beam JSON artifact, not a calibrated or certified hydrographic product.

## Unavailable navigation in mission recordings

Vehicle mission trace version 3 represents an unavailable position and velocity as paired
`null` fields with `healthy: false`. The runtime retains the declared origin, withdraws
output authority and records a blocked estimator-loss outcome. It does not invent a position,
velocity or fresh source time. Replay validates that outcome. Version 2 keeps its original
vector-only contract; existing recordings retain their format and decisions.

## Reproduction and remaining gates

```sh
./buddy air:simulate --scenario nominal --seconds 120
./buddy ground:simulate --scenario nominal --seconds 120
./buddy ground:simulate --scenario logistics --seconds 120
./buddy surface:simulate --scenario harbour-return --seconds 120
./buddy surface:simulate --scenario nominal --survey /tmp/modeled-harbour-survey.json
```

The scenario lists also include sensor/localization loss, RC override, implement/people/range
interlocks and host loss as applicable. Tests compare public decisions and physical error bounds,
recompute mission replay, reject altered traces and exercise payload uncertainty and session reuse.
All evidence is owned physics simulation. The Pico neutral-only board image does not run these
TypeScript controllers. Native board execution, external firmware SITL, HIL and measured physical
vehicle acceptance remain separate gates. A separate [VTOL development guide](vehicles-vtol.md)
covers the hover-only command and an experimental lift-and-cruise library profile with a native
`vtol:simulate` command for nominal and named fault/operator scenarios. The latter
executes a bounded modeled front/cruise/back/vertical-landing route with stable-phase pause and
resume, plus explicitly declared hover-and-land transition recovery. Complete recovery/abort
envelopes and measured hybrid energy qualification remain open. The common workspace now includes
the same VTOL cases, phase selection, counted recovery edges and captured mode/battery playback. Helicopter,
soaring, blimp and other airframe families remain explicit roadmap work.

Read [air](vehicles-air.md), [ground](vehicles-ground.md), [surface](vehicles-surface.md), [subsea](vehicles-subsea.md),
[mission semantics](missions.md) and [the replacement matrix](roadmap/feature-coverage.md).

## Subsea inspection records

The six-axis ROV profile adds eight signed thrusters, hydrodynamic/current and positive-buoyancy
assumptions, pressure depth, capture-attitude DVL rotation, growing local uncertainty and tether/leak
interlocks. A new scoped inspection capture waits for post-request camera/sonar measurements. Its
modeled PGM P5 fixture, forward ray and vertical bottom range retain the owned local capture pose
and source epochs. The native CLI can write the JSON artifact; the common stx workspace displays
its pixels, ranges and raw source counts. These are synthetic observations, not acquired hardware
imagery, imaging sonar or certified inspection coverage.
