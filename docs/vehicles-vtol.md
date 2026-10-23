# VTOL development

The owned lift-and-cruise model can execute a **hover-only** mission through the shared raw sensor,
estimator, mission, authority and independent output-lease runtime. It takes off vertically, reaches
a nearby hover waypoint and lands against fresh modeled contact evidence. Wing transitions and
cruise control are not implemented in this hover profile. A separate experimental library controller
is described below. This development profile is separate from the selectable
profiles in the `/missions` workspace.

```sh
./buddy vtol:hover
./buddy vtol:hover --scenario host-loss
./buddy vtol:hover --scenario imu-loss
```

The native Stacks command defaults to 60 virtual seconds. It accepts `hover`, `imu-loss`,
`position-loss`, `vehicle-sensor-loss`, `host-loss`, `rc-override` and `kill`. Faults begin at 3000 ms,
after takeoff. A report retains the actual `completed`, `blocked`, `host-lost` or `duration-exhausted`
status. Exit 0 means the selected demonstration matched its expected outcome, observed flight,
retained neutral pusher/surfaces and ended with neutral board outputs. It does not turn a fault
into a completed mission. An unmatched outcome, invalid option or insufficient duration exits 1.

The copied standalone CLI registers the same command definition:

```sh
bun run runtime:cli
./storage/runtime-build/cli/drone vtol:hover
```

## Model and measurements

The fictional 2.5 kg body has four vertical rotors, each limited to 12 N, with 60 ms motor response
and a 120 N/s slew limit. An independent 14 N pusher and the owned trainer's aerodynamic surfaces
share the rigid body. Rotor allocation preserves collective thrust first, then roll/pitch demand,
then yaw. No coefficient is measured from a purchased airframe.

The hover demonstration commands the pusher and three surfaces to zero. Calibrated modeled raw
IMU/GNSS samples feed the owned estimator. The controller receives estimated pose, a current qualified
raw gyro capture and delayed contact measurements. Plant truth is used for sensor synthesis and
independent evaluation, never as controller input. Initial north heading and a flat contact plane
are declared simulation assumptions. A fictional skid friction coefficient of 0.5 supplies bounded
horizontal braking from normal support at contact. It does not model impact impulses, gear deformation,
tipping, damage or uneven terrain. Airborne motion receives no contact friction. Landing uses a 0.1 m below-plane target to obtain finite
contact; mission completion still requires estimated arrival, low speed, settling and fresh contact.

Contact and paused-ground neutral decisions occur after estimator/rate validation. A stale gyro
cannot become acceptable because contact is present. Control faults latch for the controller
lifetime. Each session owns its plant, controller, sensor sequence and returned actuator arrays.
RC takeover, kill and sensor loss revoke shared authority. Host death leaves its final host snapshot
stale while the independently ticking modeled board expires the output lease.

The mission's 50 Wh capacity, 1200 W ceiling and 30% reserve are declared budget inputs for this
fictional hover experiment. They are not identified electrical power, measured endurance or a
complete hybrid energy model. Neutral outputs during an airborne fault do not establish a safe
emergency landing. Physical flight commands remain disabled.

## Explicit hover observation in library plans

Library plans can declare a VTOL-only `vtol-mode` task with `mode: 'hover'`, an explicit heading
and a finite timeout. The held position must equal the request position. The mission emits a task, reference and epoch-bound request. The hover adapter
requires fresh post-request contact, estimated pose and raw gyro sources, with a 200 ms stability
dwell on both the monotonic decision clock and source coverage. It reports the oldest source capture epoch. The shared runtime delivers each controller
response once on the next mission tick and retains it for replay. Initial contact holds all outputs
neutral until observation is qualified. Unobserved headings expire, and this hover adapter reports
cruise requests as aborted. This is a library prerequisite, not front/back transition control or a
new CLI scenario. Existing hover-only recordings keep their prior shapes.

## Experimental lift-and-cruise library controller

`createVtolTransitionProfile()` in `resources/functions/drone/vehicles/vtol/transition-profile.ts`
is a separate development experiment on the same owned runtime. Its nominal mission observes initial
hover, takes off vertically to 15 m, requests a front transition, flies a cruise leg, requests back
transition, returns to the back request's capture point, observes settled hover, and lands vertically.
A turning leg also has an actual completed model campaign. This profile is not registered as a CLI
scenario or selectable workspace profile.

The controller receives measured relative airspeed, differential pressure, airflow angles and modeled
rotor/pusher response, together with the qualified raw gyro and estimated navigation. Delayed airflow
angles are transformed through their matching capture-time attitude. The measured NED airflow vector
is held to the decision and then expressed in the current gyro-predicted body attitude. This is a
bounded synthetic observation approximation, not identified wind estimation or physical air-data
calibration. Banked navigation follows the route while coordinated yaw follows the measured air
course. Surface torque and residual rotor torque are allocated together; measured wing lift reduces
collective rather than adding full rotor weight support on top of the wing.

Front confirmation requires sustained measured 12 to 14 m/s relative airflow, bounded angles,
height/rate and less than 1 N of measured and commanded lift-rotor support. Both decision time and
oldest-source coverage must qualify for 500 ms, including the attitude and gyro epochs used to
transform delayed airflow. Ground speed or a timer alone cannot confirm cruise.
A failed modeled pusher and an artificial co-moving-air fixture retain failed transition outcomes.

Back transition turns the pusher off and decelerates under the declared aerodynamic model before
returning to the original capture point at a horizontal target speed bounded to 3 m/s. The nominal
model needs about 38 seconds for deceleration, return and hover qualification. Observed hover also
requires wrapped heading error within 0.1 rad for the complete 500 ms dwell. Hover/back requests
therefore have a finite 45-second ceiling; front requests retain 15 seconds. The original 15-second
back budget still fails without retry or a claimed landing. This is a virtual task allowance,
not a wall-clock test timeout. The complete declared mission budget is 131,520 ms, or 43.84 Wh at its
1200 W ceiling, with 100 Wh capacity and 30% reserve. These remain declared planning values, without
a complete hybrid electrical-power law or measured battery identification.

The experiment keeps the 2 m transition-height deviation, 0.6 rad roll, 0.5 rad pitch and 22 m/s
speed guards. Its own target range is bounded to 400 m. The quadcopter and hover development kernel's
existing 3 m/s horizontal target and 100 m target-radius guards are unchanged. Source, capture-pose,
reference and clock faults latch. Real modeled sensor loss, RC override, kill and host-loss campaigns
cover front transition, cruise, back transition and post-back landing through the independent output
lease. Neutral outputs during an airborne failure do not demonstrate a safe recovery or landing.

## Operator actions in modeled sessions

The shared runtime accepts a captured schedule of `pause`, `resume`, `recover` and `abort` actions.
For example, from a TypeScript file in the project root:

```ts
import { runVehicleSimulation } from './resources/functions/drone/vehicles/runtime'
import { createVtolTransitionProfile } from './resources/functions/drone/vehicles/vtol/transition-profile'

const report = runVehicleSimulation(createVtolTransitionProfile(), {
  seconds: 160,
  missionActions: [
    { atMs: 20000, action: 'pause' },
    { atMs: 40000, action: 'resume' },
  ],
})
```

Each schedule record contains only `atMs` and `action`. Up to 32 events must have unique,
strictly increasing 20 ms epochs after the automatic start at 600 ms and within the requested
simulation duration. Validation and capture happen before session resources are created. Events
are consumed once by the existing mission policy and retained in its replayable trace. An omitted
or empty schedule preserves prior recordings and report fields.

A qualified hover pause holds the captured estimated position. Wing-borne cruise uses a captured
clockwise 60 m holding circle, with coordinated bank and radial course feedback. The complete circle
must fit inside the declared 400 m horizontal envelope. Straight and banked-entry model campaigns
hold the same 8 m radial-error bound after six seconds, maintain wing support and height, then resume
the route and land. Post-back airborne pause also arrests descent around the captured position.
Qualified stopped ground contact stays neutral during pause, with source and envelope checks applied
before that return. Sensor loss, RC takeover, kill and host loss retain authority withdrawal.

`recover` pauses the already running session until explicit `resume`. Fresh-process restoration after
host loss or a changed estimator reference remains a separate gate. Pending initial-hover, front or
back mode work without a declared recovery route retains uncertain-outcome refusal for pause/recover.
Those refusals release modeled outputs. Without that route, `abort` also terminates the modeled mission
and releases outputs. Neither result establishes an airborne landing.

Task execution time stops during pause. Global endurance and the declared energy charge continue,
so a later scheduled resume can be preempted by reserve, endurance, health or authority refusal.
Operator actions never extend the original planning allowance or rearm revoked authority. The
transition library and these actions remain separate from the hover-only CLI and common workspace.

## Declared transition recovery routes

A `vtol-mode` task can declare `onFailure` as the ID of a dedicated hover task followed by a
terminal landing task on the declared contact plane. The default development profile has no such
route. Plans opt in explicitly, and every recovery edge participates in the existing acyclic time
and reserve calculation before session resources are created. Normal success edges cannot enter
the recovery hover, and recovery cannot retry the interrupted task or declare another failure route.

For example, declare a return to the origin after an interrupted front transition:

```ts
const profile = createVtolTransitionProfile()
const front = profile.mission.tasks.find(task => task.id === 'front')!
if (front.kind !== 'vtol-mode') throw new Error('Expected front mode task')
front.onFailure = 'recover-hover'
profile.mission.tasks.push(
  { id: 'recover-hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: 45000, next: 'recover-land' },
  { id: 'recover-land', kind: 'land', positionM: [0, 0, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 35000 },
)
const aborted = runVehicleSimulation(profile, {
  seconds: 160,
  missionActions: [{ atMs: 13000, action: 'abort' }],
})
```

The imports are the same as in the previous example. Timeout or a correlated controller abort uses
the declared route. An operator `abort`, `pause` or `recover` while that mode task owns execution
uses it too. A new hover request binds `supersedesEventId` to the actual cancelled request and records
its original task, cause and epoch in `mission.recovery`. Before the first command dispatch, the
failed event is null and no cancellation ID is invented. Late old feedback cannot satisfy the new
request. Qualified source and heading dwell starts again for that new observation; it never retries
the original transition or regains revoked authority.

Pause and recover continue controlled motion until hover is observed, then hold for a **fresh explicit
resume**. Resuming follows the recovery landing route. An early resume cannot skip that qualification,
and repeated recovery does not reset its deadline. Abort continues to observed contact and ends with
`mission.state: 'aborted'` and reason `vtol-abort-landed`. The simulation report keeps its existing
`blocked` summary for an aborted mission. This is distinct from successful completion of the original
route. A timeout/controller rejection that recovers to contact ends with `vtol-recovery-landed`.

Landing holds the captured estimated approach height until horizontal position and speed qualify
descent to the selected site. Actual failed-pusher and expired-back campaigns retain rotor-supported
hover and fresh contact. The original 25-second back-recovery approach/landing case still times out
airborne. A separately declared 35-second allowance completes after about 26.94 seconds, charged to
the complete 156,520 ms / 52.1733 Wh worst-case plan. A normal 45-second back plus 45-second recovery
hover and 35-second landing exceeds the unchanged 180-second graph cap and is rejected. The phase
abort/pause/recover campaigns instead declare 40-second recovery hover and 30-second landing, fitting
176,520 ms / 58.84 Wh. These remain declared 1200 W planning charges, without identified electrical
power or measured battery endurance.

Sensor loss, reference/clock guards, RC takeover, kill, fence, reserve and global endurance remain
authoritative during recovery. Host loss still produces a stale host snapshot and separate independent
lease expiry. Fault-induced neutral outputs do not become a landing claim. These bounded library
campaigns do not qualify arbitrary wind, failed lift rotors, every transition state or physical recovery.

## Remaining implementation

[Issue #12](https://github.com/stacksjs/drone/issues/12) remains open. The experimental nominal
controller and opt-in recovery routes do not establish complete VTOL support. Complete recovery/abort
envelopes, fresh-process restoration, the complete hybrid power/reserve model, native transition CLI and
the common mission workspace still require implementation and qualification. Wind campaigns and
broader mission/envelope coverage remain necessary. Full TECS/soaring, tiltrotor/tailsitter mechanisms,
helicopters and other airframe families remain separate work. Native board control, measured airframe
identification, HIL and physical flight require their own evidence.

Read the [shared vehicle contract](vehicles.md), [fixed-wing model](vehicles-air.md) and
[authority contract](authority.md).
