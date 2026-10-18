# Feature coverage and replacement matrix

Status is for **this repository**, not the capabilities advertised by the upstream projects. Planned
means there is no native implementation yet. A protocol-compatible transport is not firmware parity.

| Feature area | Framework now | External driver exposure | Native work |
| --- | --- | --- | --- |
| Pi AI Camera and selected-person image tracking | Implemented acquisition bridge, geometric tracking, UI and loss guard. Pi execution unvalidated. | No upstream camera-control exposure | [#29](https://github.com/stacksjs/drone/issues/29) |
| Native board HAL, scheduler, watchdog, boot and memory | Neutral-only C++ kernel, host HAL and cross-compiled Pico 2 HAL; board boot/timing/watchdog validation pending | External firmware owns these today | [#2](https://github.com/stacksjs/drone/issues/2) |
| Calibration, sensor timing and quality | Native register acquisition, SI conversion, thermal/mount calibration profiles, independent age/stuck/dropout checks and replay; physical capture/calibration/timing pending | Local position/battery telemetry subset | [#3](https://github.com/stacksjs/drone/issues/3) |
| Attitude, navigation estimation, EKF, VIO, RTK and redundancy | Complementary tilt/relative-yaw, GNSS local-position Kalman blocks and pressure-relative height; heading, inertial EKF and hardware validation pending | Estimator output subset; no health-fusion parity | [#4](https://github.com/stacksjs/drone/issues/4) |
| Rate, attitude, velocity, position, allocation and tuning | Owned simulated cascaded loops/quad-X allocation with estimator feedback and rigid-body scenarios; board port, tuning and physical validation pending | Velocity-only quadcopter SITL | [#5](https://github.com/stacksjs/drone/issues/5) |
| Arming, RC override, kill, fences, battery and recovery | Versioned simulation authority, explicit arming/override/fault latches and modeled independent output expiry; board port, HIL and recovery controllers pending | No arm/mode/kill commands; physical receive-only | [#6](https://github.com/stacksjs/drone/issues/6) |
| MAVLink routing, ACK, mission/parameter protocol, signing, time and transport | Bounded MAVLink 2 command ACK/retry, named parameters, waypoint transfer/resume and optional signing; full firmware SITL, serial/TCP and deeper services pending | ArduPilot/PX4 telemetry, SITL velocity and shared acknowledged protocol subset; scripted UDP evidence only | [#7](https://github.com/stacksjs/drone/issues/7) |
| Payloads, buses, camera triggers, ESCs, power, gimbals and winches | Owned still-capture ACKs, bounded clock sync and estimator-pose association, Pi IMX500 adapter, replay and bus contracts; physical validation and other payload drivers pending | No payload actuator exposure | [#8](https://github.com/stacksjs/drone/issues/8) |
| Diagnostics, logs, replay, firmware update and configuration provenance | Owned runtime journal, loss accounting, hash verification, crash-prefix recovery, pure replay, CLI and local stx viewer; full mission correlation, hardware storage/crash evidence and signed updates pending | No log/FTP/parameter management | [#9](https://github.com/stacksjs/drone/issues/9) |
| Missions, tasks, waypoints, terrain, rally and resume | Owned versioned graph, flat-terrain/fence/rally/energy validation, physics execution, pause/resume, recorded recovery, CLI and stx viewer; correlated durable checkpoints, driver translation and hardware evidence pending | No mission upload or mission-mode control | [#10](https://github.com/stacksjs/drone/issues/10) |
| Avoidance, route planning, precision landing, follow and orbit | Owned modeled range detection, inflated route planning, terrain-clearance/RTL/selected-site landing physics; metric follow/orbit goals; physical calibration and dynamic obstacle campaigns pending | No avoidance/landing integration | [#11](https://github.com/stacksjs/drone/issues/11) |
| Fixed-wing, VTOL, heli, blimp and experimental airframes | Owned fixed-wing aerodynamic trainer with runway takeoff/survey/landing and wind/airspeed-loss tests; VTOL, helicopter, soaring, blimp and experimental families remain planned | Current drivers reject non-quadcopter heartbeats | [#12](https://github.com/stacksjs/drone/issues/12) |
| Rovers, mowing, logistics and materials handling | Owned differential traction/braking, encoder/GNSS odometry, guarded mowing coverage and scoped material-drop simulation; hardware and broader chassis/implements pending | Not exposed | [#13](https://github.com/stacksjs/drone/issues/13) |
| Surface vessels, bathymetry, water sampling and harbours | Owned planar hull/current/wind, collision inhibition, corrected single-beam export, scoped sample ACK and energy-return simulation; physical survey/sampling and broader hulls pending | Not exposed | [#14](https://github.com/stacksjs/drone/issues/14) |
| Subsea ROV, depth hold, tether and leak handling | Owned eight-thruster 6DOF physics, pressure/DVL local estimation, depth hold, tether/leak supervision and scoped synthetic camera/sonar evidence; hardware, full hydrodynamics and physical inspection pending | Not exposed | [#15](https://github.com/stacksjs/drone/issues/15) |
| Antenna pan/tilt and telemetry pointing | Owned selected-target tracking, calibrated geometry, bounded trajectories and modeled mount bench; physical/RF validation pending | Not exposed | [#16](https://github.com/stacksjs/drone/issues/16) |
| Calibrated 3D visual position and paired target fusion | Owned calibrated lens/crop/mount import, registered-depth localization, explicit GNSS pairing, conservative covariance intersection and sensor-to-control physics; measured calibration, heading, depth adapters and hardware campaigns pending | Not exposed | [#17](https://github.com/stacksjs/drone/issues/17) |
| Aerial survey, overlap/GSD, photogrammetry collection and georeferencing | Owned clipped survey planning, capture-bound synthetic PNG collection and auditable export; reconstruction, measured calibration and field accuracy pending | Not exposed | [#18](https://github.com/stacksjs/drone/issues/18) |
| LiDAR, surface processing and stockpile volume/uncertainty | Owned known-TIN/cell-grid clipping, explicit base/cut/fill, gaps, conditional bounds, reference comparison, ASC/PLY and audit export; meshing, richer formats and physical survey qualification pending | Not exposed | [#19](https://github.com/stacksjs/drone/issues/19) |
| Power lines, turbines, solar, bridges and pipeline inspection | Owned bridge-face route/clearance simulation, captured visible/synthetic thermal imagery, quality, explicit source-bound reviews and revisit comparison; real asset/hardware/defect qualification and richer families pending | Not exposed | [#20](https://github.com/stacksjs/drone/issues/20) |
| Crop scouting, multispectral calibration and livestock monitoring | Planned | Not exposed | [#21](https://github.com/stacksjs/drone/issues/21) |
| Spraying, spreading, prescription maps and implement interlocks | Planned | Not exposed | [#22](https://github.com/stacksjs/drone/issues/22) |
| SAR, fire/disaster support and authorized police observation | Planned | Not exposed | [#23](https://github.com/stacksjs/drone/issues/23) |
| Perimeter patrol, scheduling, docks and charging | Planned | Not exposed | [#24](https://github.com/stacksjs/drone/issues/24) |
| Cargo, long-range/BVLOS cases and redundant links | Planned; operational authorization is a separate evidence requirement | Not exposed | [#25](https://github.com/stacksjs/drone/issues/25) |
| Gimbal/camera control, smooth paths and broadcast timecode | Planned | Not exposed | [#26](https://github.com/stacksjs/drone/issues/26) |
| Environment, wildlife, anti-poaching observation and atmospheric samples | Planned | Not exposed | [#27](https://github.com/stacksjs/drone/issues/27) |
| Deep feature audit, refresh and conformance gates | Pinned directory accounting implemented; detailed parity planned | No general parity claim | [#28](https://github.com/stacksjs/drone/issues/28) |

## Auditable source baseline

Every top-level entry in the selected roots is retained in [upstream-inventory.json](upstream-inventory.json)
with a pinned source URL and linked work item. Those are the module-level scope boundaries. The audit
issue must enumerate deeper modes, commands, parameters, hardware drivers and failure cases before
anyone can label a domain fully covered. Airframe support, peripheral support, UI workflows, survey
processing and approved operations are different claims and require different evidence.

Primary sources: [PX4 modules](https://github.com/PX4/PX4-Autopilot/tree/ddcaad6601be20453ec6acd0f08e567af3a7e1bb/src/modules),
[PX4 driver families](https://github.com/PX4/PX4-Autopilot/tree/ddcaad6601be20453ec6acd0f08e567af3a7e1bb/src/drivers),
[ArduPilot libraries](https://github.com/ArduPilot/ardupilot/tree/afeb9c4941543d97f3e04fecf257b8f598f49a6a/libraries),
[PX4 vehicle overview](https://github.com/PX4/PX4-Autopilot),
[ArduPilot vehicle/documentation overview](https://ardupilot.org/ardupilot/).

Behavior-level coverage is tracked by the [executable parity audit](../parity.md). Its structural
gate passes only audit integrity; it reports full parity and source review as incomplete.
