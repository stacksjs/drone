# Owned subsea inspection profile

Issue #15 adds a modeled tethered ROV to the same sensor, estimator, mission,
authority and independent output watchdog pipeline as the other owned profiles.
All physical actuator outputs remain inhibited. The simulation does not control
an ROV, acquire a real camera image, or communicate with a DVL or sonar device.

## Run and inspect

```sh
./buddy subsea:simulate --scenario nominal --seconds 120
./buddy subsea:simulate --scenario current --inspection storage/app/subsea-inspection.json
./buddy subsea:simulate --scenario tether-loss
```

The packaged Drone CLI exposes the same `subsea:simulate` command. Native Stacks
`defineCommand` handles options and `@stacksjs/storage/files` writes a local
JSON artifact. Numeric options use string defaults and explicit finite bounds.
The common mission workspace also accepts the subsea profile and its recording.

The mission starts at the declared surface, dives to `[0, 0, 2]`, translates to
`[2, 0, 2]`, captures one scoped inspection observation, returns to `[0, 0, 0]`,
and stops. Coordinates are metres in LOCAL_NED, with positive down measured
from the declared local water surface. The origin fields are fixture alignment,
not a georeferenced underwater position. Relative yaw starts north by assumption.
The depth fence is 0 to 8 m, with a 0.1 m allowance above the modeled surface.

## Physics and navigation

Eight signed thruster forces drive a six degree of freedom rigid body. The model
includes mass, added mass, rotational inertia, drag relative to water current,
restoring moments, a geometric tether load and 2 N of positive buoyancy. Its
thruster values are idealized newtons. They are not PWM commands, measured motor
curves, or a hardware bill of materials.

Owned raw IMU observations provide tilt. Delayed hydrostatic pressure and
bottom-locked BODY_FRD DVL velocity provide local navigation; underwater GNSS
observations are absent. Capture-time owned attitude rotates velocity into NED.
Retained packets are not integrated twice. Navigation reports its declared
pressure/DVL uncertainty and latches loss instead of silently reacquiring a
changed position frame. Drift, initial alignment and pressure reference remain
limits. The compact CLI report includes actual observed IMU/GNSS sequence counts.

The controller uses estimated state and qualified packets, never model truth.
It holds depth and local position, allocates body force and torque across the
thrusters, and yields to shared authority and watchdog leases. A paused mission
holds its observed underwater position. Neutral thrusters and positive buoyancy
do not establish a reliable ascent route around structures or an entangled tether.

## Capture evidence

`inspection-capture` is bound to one event, task, operation, position, reference
and issue/expiry interval. Acquisition requires active autonomous authority and
the exact running pending mission scope. It waits for a new camera/sonar packet
captured at or after the request. A prior frame cannot satisfy a new command.
Intervening authority or scope loss produces an uncertain result and consumes
the event identity. It never automatically retries an uncertain observation.

The reducer replays mission decisions, joins the confirmed ACK to its recorded
packet and capture pose, and verifies camera identity, literal luminance bytes,
ranges, pose and source epochs. These checks detect inconsistent local records;
they do not authenticate a maliciously rewritten recording.

Each frame retains a synthetic 4 by 4 luminance image, a P5 header plus 16 pixel
bytes, a BODY_FRD forward sonar wall hit, vertical LOCAL_NED down seabed clearance, LOCAL_NED capture pose, quaternion,
source/prediction epochs, raw packet and declared uncertainty. This is a small
modeled fixture. It is not photographic inspection evidence, imaging sonar,
photogrammetry, area coverage, defect detection, a point cloud, or a globally
registered survey.

Default one-standard-deviation assumptions are position 0.1 m, attitude 0.02 rad,
time 2 ms and range 0.05 m. They describe the fixture, not instrument calibration
or proven estimator accuracy. CLI `--position-sigma`, `--attitude-sigma`,
`--clock-sigma` and `--range-sigma` let a caller declare alternatives; clock
uncertainty cannot understate the sensor's 1 ms declaration. These fields do not
establish a certified inspection or survey uncertainty budget.

## Fault fixtures

`nominal` and `current` exercise complete inspection and return. Other fixtures
introduce `leak`, `tether-overload`, `tether-loss`, `dvl-loss`, `pressure-loss`,
`depth-limit`, `emergency`, `host-loss`, `rc-override`, `kill`, `imu-loss` and
`sensor-loss` after 5 seconds. Host loss leaves the independent board to expire
its lease; other failed interlocks block the mission and release outputs. A
fault run with no confirmed capture rejects `--inspection` export instead of
writing an empty artifact that could be mistaken for completed work.

## Hardware path for the existing Pi 5

These are integration candidates and acceptance requirements, not hardware
support claims. Verify the mechanical, electrical and software interfaces of the
specific revisions before buying. A commercial underwater navigation system is
a separate project from the earlier outdoor quadcopter budget.

| Function | Candidate and source | Integration still required |
| --- | --- | --- |
| Frame, pressure housing, buoyancy and propulsion | [BlueROV2 with Heavy Configuration](https://bluerobotics.com/store/rov/bluerov2/) provides an example eight-thruster layout. The stock product uses a Pi 4, Navigator and ArduSub. | A custom Pi 5 tray, enclosure thermal path, buoyancy trim, independent supervisor, measured actuator model and output inhibition must be engineered. Buying this platform does not install our runtime. |
| Individual thrusters | [T200 thrusters](https://bluerobotics.com/store/thrusters/t100-t200-thrusters/t200-thruster-r2-rp/) require one suitable ESC per motor, a power source and control signal. | Validate thrust direction, current, dead band, reversal, supply protection and wet-test performance. Our idealized +/-15 N allocation is not a T200 calibration. |
| Pi power and cooling | Use the [Pi 5 power-delivery guidance](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-009856-WP-1-USB%20Power%20delivery%20on%20Raspberry%20Pi%205.pdf) and [Active Cooler](https://www.raspberrypi.com/products/active-cooler/) as electrical and thermal starting points. | Verify regulated supply and peripheral budget at the Pi, plus heat rejection inside the sealed enclosure. The cooler alone does not establish underwater enclosure cooling. |
| Tether and topside computer | A matched [Fathom tether](https://bluerobotics.com/store/cables-connectors/cables/fathom-rov-tether-rov-ready/) and two [Fathom-X interfaces](https://bluerobotics.com/store/comm-control-power/tether-interface/fathom-x-tether-interface-board-set-copy/) provide a candidate Ethernet link, one interface at each end. | A topside laptop, tether management, correct penetrators, link-age qualification and independent operator stop are required. Our geometric tether model does not qualify cable drag, snagging or tensile strength. |
| Pressure/depth | [Bar pressure sensors](https://bluerobotics.com/store/sensors-cameras/sensors/bar-depth-pressure-sensor/) offer a hydrostatic measurement candidate. | Implement the actual bus protocol, compensate/calibrate pressure and temperature, measure surface pressure and water density, and test clock and failure behavior. Sensor resolution does not prove depth accuracy. |
| Bottom-relative velocity | [Water Linked DVL](https://docs.waterlinked.com/dvl/integration/) exposes Ethernet TCP JSON and model-specific serial interfaces. | Implement framing, clock alignment, mounting calibration and quality handling. Follow [installation and submerged operation guidance](https://docs.waterlinked.com/dvl/quickstart/). Bottom lock and a clear acoustic path must be verified. |
| Camera and illumination | [Blue Robotics camera options](https://bluerobotics.com/product-category/sensors-cameras/cameras/) include a low-light HD USB camera and housed underwater cameras. | Match enclosure/window geometry, power, USB budget and lighting. Calibrate underwater optics and capture timestamps. The existing Pi AI Camera terrestrial adapter does not establish underwater calibration or sealing. |
| Range or imaging sonar | [Blue Robotics sonars](https://bluerobotics.com/product-category/sonars/) distinguish single-beam Ping ranging from Ping360 scanning imaging sonar. | Select the required evidence product, implement its protocol and timing, and validate mounting and acoustic interference. A synthetic scalar range does not implement either product's image acquisition. |

DVL dead reckoning drifts. [Water Linked's operation guidance](https://docs.waterlinked.com/dvl/dvl-a50_a125-gui/)
requires checking valid velocity, bottom lock and uncertainty, and warns against
treating its map as an absolute reference without external positioning. This
profile intentionally blocks when bottom lock is lost; water-relative tracking
is a different measurement model and is not substituted for seabed velocity.

Before any physical output work, preserve independently measured enclosure,
leak, power, thermal, sensor timing, thruster and tether evidence; implement the
board target and tether protocol; demonstrate operator stop and watchdog expiry;
and validate recovery behavior in a controlled tank. Open-water hull, dam,
pipeline and aquaculture inspection remain acceptance work. See
[ADR 0015](https://github.com/stacksjs/drone/blob/main/docs/adr/0015-subsea-profile.md) for the software boundary.
