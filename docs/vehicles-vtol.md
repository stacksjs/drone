# VTOL hover development

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

## Remaining implementation

[Issue #12](https://github.com/stacksjs/drone/issues/12) remains open. The experimental nominal
controller does not establish complete VTOL support. Phase pause/recovery, explicit bounded
transition abort and landing, the complete hybrid power/reserve model, native transition CLI and
the common mission workspace still require implementation and qualification. Wind campaigns and
broader mission/envelope coverage remain necessary. Full TECS/soaring, tiltrotor/tailsitter mechanisms,
helicopters and other airframe families remain separate work. Native board control, measured airframe
identification, HIL and physical flight require their own evidence.

Read the [shared vehicle contract](vehicles.md), [fixed-wing model](vehicles-air.md) and
[authority contract](authority.md).
