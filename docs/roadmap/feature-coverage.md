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
| Arming, RC override, kill, fences, battery and recovery | Companion leases/envelope only; board supervisor planned | No arm/mode/kill commands; physical receive-only | [#6](https://github.com/stacksjs/drone/issues/6) |
| MAVLink routing, ACK, mission/parameter protocol, signing, time and transport | Small CRC-checked v1/v2 subset | ArduPilot/PX4 heartbeat + position/battery; SITL velocity | [#7](https://github.com/stacksjs/drone/issues/7) |
| Payloads, buses, camera triggers, ESCs, power, gimbals and winches | IMX500 acquisition only | No payload actuator exposure | [#8](https://github.com/stacksjs/drone/issues/8) |
| Diagnostics, logs, replay, firmware update and configuration provenance | Bounded simulator history; full operations planned | No log/FTP/parameter management | [#9](https://github.com/stacksjs/drone/issues/9) |
| Missions, tasks, waypoints, terrain, rally and resume | Planned | No mission upload or mission-mode control | [#10](https://github.com/stacksjs/drone/issues/10) |
| Avoidance, route planning, precision landing, follow and orbit | Basic follow; obstacle/range/navigation stack planned | No avoidance/landing integration | [#11](https://github.com/stacksjs/drone/issues/11) |
| Fixed-wing, VTOL, heli, blimp and experimental airframes | Planned vehicle-specific controls | Current drivers reject non-quadcopter heartbeats | [#12](https://github.com/stacksjs/drone/issues/12) |
| Rovers, mowing, logistics and materials handling | Planned | Not exposed | [#13](https://github.com/stacksjs/drone/issues/13) |
| Surface vessels, bathymetry, water sampling and harbours | Planned | Not exposed | [#14](https://github.com/stacksjs/drone/issues/14) |
| Subsea ROV, depth hold, tether and leak handling | Planned | Not exposed | [#15](https://github.com/stacksjs/drone/issues/15) |
| Antenna pan/tilt and telemetry pointing | Planned | Not exposed | [#16](https://github.com/stacksjs/drone/issues/16) |
| Calibrated 3D visual position and paired target fusion | 2D observations intentionally cannot supply metric Target | Not exposed | [#17](https://github.com/stacksjs/drone/issues/17) |
| Aerial survey, overlap/GSD, photogrammetry collection and georeferencing | Planned | Not exposed | [#18](https://github.com/stacksjs/drone/issues/18) |
| LiDAR, surface processing and stockpile volume/uncertainty | Planned; collection/reconstruction/measurement distinguished | Not exposed | [#19](https://github.com/stacksjs/drone/issues/19) |
| Power lines, turbines, solar, bridges and pipeline inspection | Planned | Not exposed | [#20](https://github.com/stacksjs/drone/issues/20) |
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
