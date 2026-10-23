# VTOL hover development

The owned lift-and-cruise model can execute a **hover-only** mission through the shared raw sensor,
estimator, mission, authority and independent output-lease runtime. It takes off vertically, reaches
a nearby hover waypoint and lands against fresh modeled contact evidence. Wing transitions and
cruise control are not implemented. This development profile is separate from the selectable
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

## Remaining implementation

[Issue #12](https://github.com/stacksjs/drone/issues/12) remains open for full correlated front/back
transition control and observed outcomes, airspeed and attitude
qualification, bounded transition abort/recovery, complete hybrid power/reserve accounting and
the common mission workspace. Full TECS/soaring, tiltrotor/tailsitter mechanisms, helicopters and
other airframe families remain separate work. Native board control, measured airframe identification,
HIL and physical flight require their own evidence.

Read the [shared vehicle contract](vehicles.md), [fixed-wing model](vehicles-air.md) and
[authority contract](authority.md).
