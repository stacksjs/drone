# VTOL development

The owned lift-and-cruise model can execute a **hover-only** mission through the shared raw sensor,
estimator, mission, authority and independent output-lease runtime. It takes off vertically, reaches
a nearby hover waypoint and lands against fresh modeled contact evidence. Wing transitions and
cruise control are not implemented in this hover profile. A separate experimental library controller
is described below. The `/missions` workspace selects the full-route experiment and its named
cases; the hover-only command remains a separate experiment.

```sh
./buddy vtol:hover
./buddy vtol:hover --scenario host-loss
./buddy vtol:hover --scenario imu-loss
./buddy vtol:hover --electrical
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
./storage/runtime-build/cli/drone vtol:hover --electrical
```

## Model and measurements

The fictional 2.5 kg body has four vertical rotors, each limited to 12 N, with 60 ms motor response
and a 120 N/s slew limit. An independent 14 N pusher and the owned trainer's aerodynamic surfaces
share the rigid body. Rotor allocation preserves collective thrust first, then roll/pitch demand,
then yaw. No coefficient is measured from a purchased airframe.

The VTOL wing uses the fictional `projected-incidence-v3` extension. At zero sideslip its forward
pre-stall response exactly matches the trainer. Reversed chordwise incidence is folded, changes
coefficient sign and fades toward broadside. Longitudinal lift, drag and static pitch use the fraction
of dynamic pressure in the chord/vertical airflow plane. This removes the force/moment singularity
where that plane's velocity goes to zero while spanwise flow stays finite. Total pressure and raw
airflow angles remain available to capture and envelope guards. The separately declared lateral,
surface and rate responses retain total pressure. The default fixed-wing trainer is unchanged.
These are fictional coefficients, without measured post-stall, spanwise or reverse-flight data.
Full-route CLI reports identify this curve with `aerodynamicsModel: 'projected-incidence-v3'`.

The prior `folded-incidence-v2` removed the reverse-flow angle-wrap jump at zero spanwise velocity,
but retained a 0.9555 N force jump between `[+1e-8, 2, 0]` and `[-1e-8, 2, 0]` m/s. Approaching the
same lateral-flow axis from positive/negative vertical velocity produced a 4.0768 N vertical-force
jump. The v3 checks cover these approach directions, finite zero-flow response and non-positive
unpowered airflow work. They establish bounded mathematical properties, not a calibrated airframe.
A predeclared 16-case runtime campaign introduces 2 m/s head, tail, east and west wind at observed
front, cruise, back and landing phase entries. All complete their declared heading plans through
source-qualified hover, contact and replay within the original budgets. Wind onset is applied on
the next actual integration step; the CLI/workspace wind selectors still use the fixed 1000 ms onset.

Hover control aligns the thrust direction separately from its heading correction. A large, saturated
yaw error therefore cannot rotate the requested position correction into another axis. Opposite
thrust directions have no unique shortest tilt axis; that unsupported condition inhibits and latches
neutral output. Existing body-rate bounds, PID gains, source guards and allocation priorities remain.

Back-transition braking compares the linear pre-stall estimate with 41 pitch candidates in the
existing -0.08 to 0.3 rad range. It evaluates the declared nonlinear wing/rotor force balance against
qualified captured airflow and estimated ground motion. Candidates must admit 0 to 48 N of lift-rotor
thrust while supporting the requested vertical force; high-speed candidate incidence remains within
0.3 rad. The finite transition deadline, source guards, capture dwell and independent authority still
apply. Before low-speed rotary capture, the nose and candidate force search follow qualified measured
airflow. The requested final hover heading remains the capture condition after braking. Replacing a
correlated back request preserves rotary capture once reached, so recovery cannot restart forward-flight
braking during a reverse position return.

### Bounded wind cases

The library campaign applies sustained 2 m/s headwind or tailwind to the actual world model from
1000 ms, including takeoff, transitions, cruise and landing. Both routes complete within their
original budgets using the raw sensor/estimator/controller runtime. Six named cases are shared by
Buddy, the copied standalone CLI and the mission workspace:

| Scenario | World wind N/E/D, m/s | Back-hover heading from north | Required recorded outcome |
| --- | --- | --- | --- |
| `headwind-2mps` | -2, 0, 0 | 0 rad, north | Completed route and contact |
| `tailwind-2mps` | 2, 0, 0 | 0 rad, north | Completed route and contact |
| `east-crosswind-limit-2mps` | 0, 2, 0 | 0 rad, north | Blocked back-transition envelope, no hover/landing claim |
| `west-crosswind-limit-2mps` | 0, -2, 0 | 0 rad, north | Blocked back-transition envelope, no hover/landing claim |
| `east-crosswind-2mps` | 0, 2, 0 | -pi/2 rad, west | Completed route and contact |
| `west-crosswind-2mps` | 0, -2, 0 | +pi/2 rad, east | Completed route and contact |

```sh
./buddy vtol:simulate --scenario tailwind-2mps --electrical
./buddy vtol:simulate --scenario east-crosswind-limit-2mps --electrical
./buddy vtol:simulate --scenario east-crosswind-2mps --electrical
./storage/runtime-build/cli/drone vtol:simulate --scenario headwind-2mps --electrical
```

`windEvidence` retains the declared LOCAL_NED vector and onset, observed calm/applied plant steps,
first/last matching application epochs, mismatch count and separate world/outcome checks. Actual
world inputs are observed after plant integration, outside controller inputs. An absent, wrong or
mistimed wind cannot pass under the scenario name. A partial route remains unmatched. Wind cases
reject `--phase`; their declared onset is 1000 ms. Exit 0 means the selected demonstration matched,
so a crosswind limit report still has `status: 'blocked'`, no confirmed back hover and no contact.

A tailwind library run can also be constructed explicitly from a script under `scripts/`:

```ts
import { createVtolTransitionProfile } from '../resources/functions/drone/vehicles/vtol/transition-profile'
import { runVehicleSimulation } from '../resources/functions/drone/vehicles/runtime'

const profile = createVtolTransitionProfile({ electrical: true })
profile.faults = (_scenario, atMs) => ({ windMps: atMs >= 1000 ? [2, 0, 0] : [0, 0, 0] })
const result = runVehicleSimulation(profile, { seconds: 160 })
```

The fixed north-facing east/west crosswind plans still reach the back-transition envelope guard
without confirmed hover or landing. The retained v2 east-case diagnosis, before the v3 flow projection,
records a reverse return at 38,000 ms where
the modeled aerodynamic yaw moment is approximately -0.729 Nm while the fully allocated opposing
rotor yaw moment is only +0.416 Nm, with the rudder at its +0.4 rad bound. The qualified airflow capture
is 60 ms old, attitude 20 ms and position 100 ms, within the unchanged source guards. This is an
observed authority shortage, not evidence of a mismatched capture frame.

A separate level-hover calculation with the same 2 m/s crosswind and full opposing rudder leaves
-0.736 Nm of aerodynamic yaw moment. Lift rotors preserving the fictional 24.517 N weight support
can oppose at most +0.470 Nm. This worked example does not establish a full steady-flight feasibility
envelope, but changing gains cannot supply the missing torque in that condition. Neutral outputs
at the original airborne failure do not establish a safe landing.

The two wind-facing plans differ from their fixed-heading counterparts only in the declared
back-hover heading and plan identity. They use the existing `vtol-mode.headingRad` mission contract
and the same shared controller, model, reserve and finite budgets. The front heading remains north. These plans complete the source-qualified modeled hover
confirmation and contact route in the declared wind. Their extra `backHeadingRad` declaration and
`backHeadingMatched` check bind qualification to the actual recorded plan; a completed route under
a different heading remains unmatched. The plan retains its declared final heading, and there are no automatic retries.
The original `*-limit-2mps` cases keep their prior plans and blocked outcomes.

Wider wind directions, onset phases, a general feasibility planner and measured full-angle model qualification
remain in [#87](https://github.com/stacksjs/drone/issues/87). No arbitrary-wind, measured-airframe or
physical flight acceptance is claimed.

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
fictional hover experiment. The default retains a constant declared-ceiling charge. The optional
electrical model below supplies fictional propulsion/battery dynamics and delayed energy measurements.
Neither mode identifies hardware power or measured endurance. Neutral outputs during an airborne fault do not establish a safe
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
A turning leg also has an actual completed model campaign. The native `vtol:simulate` command runs
the nominal route and named cases below. The same cases are selectable in `/missions`.

```sh
./buddy vtol:simulate
./buddy vtol:simulate --electrical
./buddy vtol:simulate --scenario host-loss --phase back --electrical
./buddy vtol:simulate --scenario front-abort --electrical
./storage/runtime-build/cli/drone vtol:simulate --electrical
```

The nominal command defaults to 160 virtual seconds and accepts an integer `--seconds` from 2 to 180.
It reports the existing runtime's actual status and the three qualified initial-hover, cruise and
back-hover observations, including their event, task, reference and capture epochs. Nominal exit 0 requires
those ordered confirmations, observed estimated flight, completed landing with qualified modeled
contact, no runtime fault, neutral board outputs and no active output lease. An incomplete route
retains its partial observations and status and exits 1. The condensed report omits the full path
and trace. The library still exposes both for replay and evaluation.

Buddy discovers the typed command natively; the standalone binary registers the same definition.
`runVtolSimulation(scenario, options)` in `resources/functions/drone/vehicles/vtol/simulation.ts`
owns the case logic and condensed report for both. Simulation completion does not qualify physical
transitions, arbitrary flight envelopes or hardware landing.

### Named fault and operator cases

`--scenario` accepts `imu-loss`, `position-loss`, `vehicle-sensor-loss`, `host-loss`, `rc-override`
and `kill`. These six cases also accept `--phase`, which defaults to `front`:

| Phase | Declared injection epoch | Required pre-injection task |
| --- | --- | --- |
| `front` | 13,000 ms | Front transition |
| `cruise` | 20,000 ms | Cruise leg |
| `back` | 30,000 ms | Back transition |
| `landing` | 68,000 ms | Vertical landing |

These are fixed model epochs. The checker verifies the actual task immediately before injection;
a changed model that reaches another task cannot silently pass under the requested phase name.
Reports retain final source epochs observed at the controller boundary. Source failures must block
within 500 ms, with the selected source absent or captured before injection. Position and vehicle
sensor cases also require the other relevant source epochs to reach injection time. RC and kill require the
matching authority observation at injection. Host loss requires the independently expired output
lease and an older host authority snapshot. None can claim mission completion or landing.

The remaining named cases use captured schedules and explicit, counted recovery routes:

| Scenario | Declared behavior | Required final outcome |
| --- | --- | --- |
| `cruise-pause-resume` | Pause at 20,000 ms, resume at 40,000 ms in the cruise leg | Completed nominal landing |
| `front-abort` | Abort at 13,000 ms through front recovery | `aborted`, `vtol-abort-landed` |
| `back-abort` | Abort at 30,000 ms through back recovery | `aborted`, `vtol-abort-landed` |
| `front-recover-resume` | Recover at 13,000 ms, resume at 40,000 ms | Completed recovery landing |
| `back-recover-resume` | Recover at 30,000 ms, resume at 80,000 ms | Completed recovery landing |
| `pusher-open-circuit` | Remove pusher demand/thrust; let front confirmation time out | Completed recovery landing, no cruise or retry |
| `back-recovery-hold` | Recover at 30,000 ms with no resume | Blocked by global endurance, no landing |

Recovery cases require the original event, replacement cancellation and source task to match, plus
the ordered mode confirmations. `operatorEvidence` retains actual actions, tasks before those actions,
pause and recovery evidence. The hold case defaults to 180 virtual seconds so it reaches the existing
176,520 ms complete mission allowance. A 160-second run remains duration-exhausted and exits 1.
The landing task may be queued while paused; it must never run without resume. The open-circuit case
requires attempted pusher command, zero measured thrust and one front attempt. It does not model
locked-rotor electrical current.

For a named case, exit 0 means its specific expected outcome matched. It does not turn `blocked`,
`host-lost` or `aborted` into a completed mission. `completeTransitions` still describes the nominal
three confirmations. Invalid selectors, `--phase` on a non-fault case, mismatched outcomes or insufficient
duration exit 1. A duration that excludes a scheduled operator action is rejected before resources
are created. Custom schedules and recovery graphs remain TypeScript inputs to the shared runtime.

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
1200 W ceiling, with 100 Wh capacity and 30% reserve. These remain declared planning values. Select
the optional electrical law below for modeled consumption; measured battery identification remains open.

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
named presets above expose specific schedules through `vtol:simulate`. Custom schedules remain
library inputs. The common workspace selects the same named presets without adding live mission control.

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
hover and fresh contact. With nonlinear braking, both the 25-second and 35-second back-recovery
approach/landing cases reach contact within their declared allowances. They retain complete
146,520 ms / 48.84 Wh and 156,520 ms / 52.1733 Wh worst-case plans, respectively. A stricter
20-second landing case expires at its exact deadline while still airborne, with a complete
141,520 ms / 47.1733 Wh plan. A normal 45-second back plus 45-second recovery
hover and 35-second landing exceeds the unchanged 180-second graph cap and is rejected. The phase
abort/pause/recover campaigns instead declare 40-second recovery hover and 30-second landing, fitting
176,520 ms / 58.84 Wh. These remain conservative 1200 W planning charges, without identified electrical
power or measured battery endurance.

Sensor loss, reference/clock guards, RC takeover, kill, fence, reserve and global endurance remain
authoritative during recovery. Host loss still produces a stale host snapshot and separate independent
lease expiry. Fault-induced neutral outputs do not become a landing claim. These bounded library
campaigns do not qualify arbitrary wind, failed lift rotors, every transition state or physical recovery.

## Fictional electrical model

Select `--electrical` in either VTOL command, or pass `{ electrical: true }` to
`createVtolHoverProfile('hover', options)` or `createVtolTransitionProfile(options)` in TypeScript.
The default/disabled profiles keep their prior reports and declared-ceiling energy accounting.
Both commands run through Buddy and the copied standalone CLI. The nominal full-route command
uses the same experimental transition library profile.

Each session owns its electrical state. The plant uses actual lagged individual rotor and pusher
thrust, with these declared coefficients:

| Source | Fictional law |
| --- | --- |
| Each of four lift motors | `4 * thrustN ** 1.5` W |
| Independent pusher | `5 * thrustN ** 1.5` W |
| Avionics and idle auxiliaries | 12 W |
| Each surface | `3 * abs(deflectionRad) / 0.4` W |
| Open-circuit voltage | 20 to 24 V, linear in remaining chemical energy fraction |
| Series resistance | 0.04 ohm |

The low-current solution of `loadW = (openCircuitV - currentA * resistanceOhm) * currentA`
sets terminal voltage and current. Chemical source power is `openCircuitV * currentA`, including
series loss. The four motors, full pusher and all surfaces together draw 948.023527 W at the load.
At the minimum open-circuit voltage their chemical source demand is 1060.486740 W, rounded upward
to a **1061 W envelope**. This is an analytic bound on this fictional law, not a motor/battery rating.
The 20 to 24 V open-circuit range is a simulation parameter; the hardware list's 4S pack retains
its own specification.

Before session allocation, the runtime requires a planning ceiling at least this envelope and
capacity matching the captured plant declaration. Existing longest-path graph validation charges
the complete declared ceiling across normal and supported failure/recovery/landing routes. With the
1200 W planning ceiling, the normal route is 43.84 Wh and the declared back-abort route is 58.84 Wh.
At 50% reserve of 100 Wh, the former fits and the latter is refused before resources are created.
The front-failure path is shorter than the normal route, so it does not increase that worst-case budget.

The plant integrates chemical source energy on its independent 4 ms steps. Before remaining energy
cannot fund one complete worst-case step, propulsion demand is cut and latched. Retained motor response
may coast down; it cannot rearm from a voltage rebound. Auxiliary draw continues to exhaustion.
Rejected rigid-body integration commits neither body nor electrical state.

Battery data travels through existing delayed, sequence/reference/capture-qualified measurements.
Energy use rounds upward to micro-watt-hours; current/voltage/load use declared milli-unit quantization.
The common qualifier rejects missing, nonfinite, inconsistent, over-envelope or decreasing consumption.
The authority and mission receive a conservative remaining-energy bound after charging the maximum
source envelope over the measurement's age. A reported supply cutoff withdraws authority even if
chemical capacity remains. Source loss never substitutes a full battery.

Reports add `energy.model` and `energy.lastObservation`. `energyUsedWh` belongs to its capture epoch;
`remainingWhLowerBound` and `remainingPercentLowerBound` include the worst-case age charge at
`observedAtMs`. Host loss leaves this host observation unchanged while independent plant consumption
and board expiry continue. Mission-policy replay uses the recorded battery observations; it does not
reconstruct the electrical plant from a mission trace alone.

Actual model campaigns cover combined front demand, all nominal phases, open-circuit pusher timeout, initial/front/back abort
landing, held recovery/resume, global endurance during pause, supply cutoff, bad battery observations,
reserve, host loss and independent sessions. With `projected-incidence-v3`,
`./buddy vtol:simulate --scenario nominal --electrical` reports a last captured use of 4.238631 Wh
at `capturedAtMs: 75680` in the retained native campaign. This fictional example does not predict
aircraft endurance. Motor/propeller advance
ratio, voltage-dependent thrust, cell temperature/degradation, current-sensor calibration and measured
capacity remain unmodeled or unqualified. The open-circuit fixture removes pusher demand and thrust;
it does not model a seized motor's electrical current.

## Mission workspace

Open `/missions`, choose `vtol` and select one of the same 20 named cases as `vtol:simulate`.
The six source/manual/host faults also expose `front`, `cruise`, `back` and `landing` injection
phases. The optional electrical checkbox selects the fictional 100 Wh model. Changing the vehicle,
scenario, fault phase or electrical selection clears the previous recording.

The workspace shows the validated worst-case time and energy allowance, requested modes and counted
`onFailure` routes before running. Record a case, then move the time cursor to inspect estimated
position, operator actions, request-bound controller observations and their capture epochs. The mode
table retains changes and confirmations. The last mode observation includes its age at the cursor;
it does not assert a continuously measured current phase.

Task playback shows each requested VTOL heading in radians from north. Wind playback shows
the declared vector/onset, the actual world exposure check and the expected completed-route or
envelope-stop outcome. The explicit wind-facing plans also show their back heading and recorded-plan
binding. The wind is a fixture input, not a measured wind estimate. The separate fixed-heading
crosswind limit recordings retain their blocked status and unsupported-envelope disclosure.

With the electrical model enabled, each row uses the runtime's already qualified sensor capture.
Used chemical energy, source/load power, current, terminal voltage and the age-charged remaining
lower bound are displayed with capture and observation times. A missing capture stays missing.
Host loss freezes host readings while the independent modeled board expires its output lease.

The final outcome and mission state retain their actual meanings. A matched abort case remains
`blocked` / `aborted`, and the held recovery remains `blocked` by global endurance without a landing
contact. A named outcome match only checks the modeled demonstration. It does not authorize flight.

Both callers construct the case through `createVtolSimulationCase()` in
`resources/functions/drone/vehicles/vtol/simulation.ts`. Its `run()` returns the recording and the
same condensed report used by `runVtolSimulation()`. The presentation adapter exposes estimated
positions and qualified captures, with no plant-position truth shortcut. Playback does not mutate
the recorded mission, persist a checkpoint or add a physical control endpoint.

## Remaining implementation

[Issue #12](https://github.com/stacksjs/drone/issues/12) remains open. The experimental nominal
controller and opt-in recovery routes do not establish complete VTOL support. Complete recovery/abort
envelopes, fresh-process restoration and identified hybrid power/voltage/cell behavior still
require implementation and qualification. Wind campaigns and
broader mission/envelope coverage remain necessary. Full TECS/soaring, tiltrotor/tailsitter mechanisms,
helicopters and other airframe families remain separate work. Native board control, measured airframe
identification, HIL and physical flight require their own evidence.

Read the [shared vehicle contract](vehicles.md), [fixed-wing model](vehicles-air.md) and
[authority contract](authority.md).
