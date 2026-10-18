# Owned autonomy roadmap

Track progress in the [GitHub roadmap index](https://github.com/stacksjs/drone/issues/30).

The goal is an owned replacement for the vehicle runtime, estimation, control, mission and payload
layers, with ArduPilot and PX4 available as optional drivers. The code in this release remains a
companion application and simulator, not a native board autopilot.

## What is implemented

- Native neutral-only bench kernel, real host-process harness, Pico 2 HAL/UF2 build and Stacks CLI.
  Board boot, timing, stack and watchdog evidence remain open in [#2](https://github.com/stacksjs/drone/issues/2).
- Native IMU/pressure/GNSS acquisition profile, typed calibration/health pipeline and simulator replay.
  Physical capture, measured calibration and clock alignment remain open in [#3](https://github.com/stacksjs/drone/issues/3).
- Owned tilt/relative-yaw, GNSS local-position filter and pressure-relative height with replay/health.
  Absolute heading, tightly coupled inertial EKF and physical validation remain open in [#4](https://github.com/stacksjs/drone/issues/4).
- Owned simulated position/velocity/attitude/rate loops, quad-X allocation and rigid-body feedback through the estimator.
  Native disabled-prop tests, measured tuning and authority validation remain open in [#5](https://github.com/stacksjs/drone/issues/5).
- Versioned simulated authority, arming/override/fault latches and independent modeled output expiry.
  Native board, physical kill/RC and HIL evidence remain open in [#6](https://github.com/stacksjs/drone/issues/6).
- Versioned owned mission graphs with frame/fence/rally/endurance validation, physics execution,
  pause/resume, recorded checkpoint recovery, conditional branches, native CLI and stx viewer.
  Whole-runtime checkpoint correlation, payload ACK reconciliation, driver translation and hardware
  evidence remain open in [#10](https://github.com/stacksjs/drone/issues/10).
- TypeScript follow/behavior library, kinematic simulator, controller leases and envelope checks.
- Pi AI Camera acquisition bridge and explicit image-space target selection/loss policy, pending Pi hardware validation.
- An optional visual guard that holds metric follow logic on lost, unconfirmed, stale or changed visual selection.
- Explicit ArduPilot and PX4 quadcopter drivers for a limited telemetry/local-SITL setpoint contract.
- Shared acknowledged command/parameter/waypoint transactions and optional strict MAVLink 2 signing.
  Scripted UDP conformance passes; firmware SITL, transports and sub-services remain open in [#7](https://github.com/stacksjs/drone/issues/7).
- PX4 Offboard preparation with a rate-checked zero-velocity stream. Both hardware drivers remain receive-only.

- Range-backed avoidance, terrain-clearance, RTL and selected-site landing through owned physics,
  with metric follow/orbit goal interfaces. Physical calibration and broader campaigns remain in [#11](https://github.com/stacksjs/drone/issues/11).
- Selected-target antenna geometry, bounded mount tracking and simulated pointing/RF evidence.
  Physical mount acceptance remains in [#16](https://github.com/stacksjs/drone/issues/16).
- An [executable behavior audit](../parity.md) with source-backed cases, evidence selectors and upstream refresh.
  Unclassified dimensions and unsupported cases remain explicit in [#28](https://github.com/stacksjs/drone/issues/28).

## Sequence

1. Deliver one deterministic board sensor-to-neutral-output loop and versioned Pi/runtime handshake.
2. Add calibrated/time-aligned sensors, an owned estimator, and physics-tested vehicle controls.
3. Establish independent authority, arming/failsafes and disabled-prop HIL before physical output.
4. Run one owned waypoint mission and acknowledged payload task with reproducible logs.
5. Add vehicle-specific dynamics and domain workflows behind the same capability contract.
6. Replace each external behavior only after equivalent normal/failure tests and hardware evidence exist.

Protocol conformance and the on-device camera desk test can proceed independently. The graph below
is intentionally not one serial chain; blockers represent the prerequisites for each proposed demo.

## Work items

| Work item | Blocked by |
| --- | --- |
| [#2 Native runtime: run a deterministic sensor-to-actuator bench loop](https://github.com/stacksjs/drone/issues/2) | None |
| [#3 Sensors: calibrate and replay time-aligned IMU, GNSS and pressure samples](https://github.com/stacksjs/drone/issues/3) | [#2](https://github.com/stacksjs/drone/issues/2) |
| [#4 Estimation: publish owned attitude and local-position estimates](https://github.com/stacksjs/drone/issues/4) | [#3](https://github.com/stacksjs/drone/issues/3) |
| [#5 Multirotor control: stabilize the first simulated quadcopter](https://github.com/stacksjs/drone/issues/5) | [#4](https://github.com/stacksjs/drone/issues/4) |
| [#6 Authority: verify arming, manual override and independent failsafes](https://github.com/stacksjs/drone/issues/6) | [#2](https://github.com/stacksjs/drone/issues/2), [#4](https://github.com/stacksjs/drone/issues/4), [#5](https://github.com/stacksjs/drone/issues/5) |
| [#7 Drivers: implement acknowledged MAVLink commands, missions and parameters](https://github.com/stacksjs/drone/issues/7) | None |
| [#8 Hardware adapters: command and verify the first camera or payload](https://github.com/stacksjs/drone/issues/8) | [#2](https://github.com/stacksjs/drone/issues/2), [#3](https://github.com/stacksjs/drone/issues/3) |
| [#9 Operations: record, replay and diagnose native missions](https://github.com/stacksjs/drone/issues/9) | [#2](https://github.com/stacksjs/drone/issues/2), [#3](https://github.com/stacksjs/drone/issues/3) |
| [#10 Mission engine: run and resume an owned waypoint mission](https://github.com/stacksjs/drone/issues/10) | [#4](https://github.com/stacksjs/drone/issues/4), [#6](https://github.com/stacksjs/drone/issues/6) |
| [#11 Navigation: avoid an obstacle and land at a selected site](https://github.com/stacksjs/drone/issues/11) | [#10](https://github.com/stacksjs/drone/issues/10), [#8](https://github.com/stacksjs/drone/issues/8) |
| [#12 Air vehicles: add fixed-wing, VTOL and helicopter simulation profiles](https://github.com/stacksjs/drone/issues/12) | [#5](https://github.com/stacksjs/drone/issues/5), [#6](https://github.com/stacksjs/drone/issues/6), [#10](https://github.com/stacksjs/drone/issues/10) |
| [#13 Ground vehicles: execute a rover logistics or mowing route](https://github.com/stacksjs/drone/issues/13) | [#2](https://github.com/stacksjs/drone/issues/2), [#4](https://github.com/stacksjs/drone/issues/4), [#6](https://github.com/stacksjs/drone/issues/6), [#10](https://github.com/stacksjs/drone/issues/10) |
| [#14 Surface vessels: survey a water route and collect a sample](https://github.com/stacksjs/drone/issues/14) | [#4](https://github.com/stacksjs/drone/issues/4), [#6](https://github.com/stacksjs/drone/issues/6), [#10](https://github.com/stacksjs/drone/issues/10), [#8](https://github.com/stacksjs/drone/issues/8) |
| [#15 Subsea ROV: inspect a structure through a tethered control profile](https://github.com/stacksjs/drone/issues/15) | [#2](https://github.com/stacksjs/drone/issues/2), [#4](https://github.com/stacksjs/drone/issues/4), [#6](https://github.com/stacksjs/drone/issues/6), [#8](https://github.com/stacksjs/drone/issues/8) |
| [#16 Antenna tracking: point a pan-tilt mount at a telemetry target](https://github.com/stacksjs/drone/issues/16) | [#7](https://github.com/stacksjs/drone/issues/7), [#8](https://github.com/stacksjs/drone/issues/8) |
| [#17 Vision: localize a selected target and fuse camera observations](https://github.com/stacksjs/drone/issues/17) | [#4](https://github.com/stacksjs/drone/issues/4), [#11](https://github.com/stacksjs/drone/issues/11), [#8](https://github.com/stacksjs/drone/issues/8) |
| [#18 Aerial mapping: fly a camera-triggered survey with georeferenced imagery](https://github.com/stacksjs/drone/issues/18) | [#10](https://github.com/stacksjs/drone/issues/10), [#8](https://github.com/stacksjs/drone/issues/8), [#9](https://github.com/stacksjs/drone/issues/9) |
| [#19 Survey processing: measure a stockpile from a LiDAR or photogrammetric surface](https://github.com/stacksjs/drone/issues/19) | [#18](https://github.com/stacksjs/drone/issues/18), [#8](https://github.com/stacksjs/drone/issues/8) |
| [#20 Infrastructure inspection: repeat an asset route and attach evidence](https://github.com/stacksjs/drone/issues/20) | [#10](https://github.com/stacksjs/drone/issues/10), [#11](https://github.com/stacksjs/drone/issues/11), [#8](https://github.com/stacksjs/drone/issues/8), [#9](https://github.com/stacksjs/drone/issues/9) |
| [#21 Agriculture sensing: scout a field with calibrated multispectral data](https://github.com/stacksjs/drone/issues/21) | [#18](https://github.com/stacksjs/drone/issues/18), [#8](https://github.com/stacksjs/drone/issues/8) |
| [#22 Agriculture application: simulate spraying and spreading with interlocks](https://github.com/stacksjs/drone/issues/22) | [#10](https://github.com/stacksjs/drone/issues/10), [#11](https://github.com/stacksjs/drone/issues/11), [#8](https://github.com/stacksjs/drone/issues/8), [#13](https://github.com/stacksjs/drone/issues/13) |
| [#23 Public safety: coordinate search, fire and disaster observation missions](https://github.com/stacksjs/drone/issues/23) | [#18](https://github.com/stacksjs/drone/issues/18), [#20](https://github.com/stacksjs/drone/issues/20), [#7](https://github.com/stacksjs/drone/issues/7) |
| [#24 Patrol: repeat a scheduled mission and dock under supervised authority](https://github.com/stacksjs/drone/issues/24) | [#10](https://github.com/stacksjs/drone/issues/10), [#11](https://github.com/stacksjs/drone/issues/11), [#7](https://github.com/stacksjs/drone/issues/7), [#9](https://github.com/stacksjs/drone/issues/9) |
| [#25 Cargo: simulate delivery, redundant links and a BVLOS operations case](https://github.com/stacksjs/drone/issues/25) | [#10](https://github.com/stacksjs/drone/issues/10), [#11](https://github.com/stacksjs/drone/issues/11), [#7](https://github.com/stacksjs/drone/issues/7), [#9](https://github.com/stacksjs/drone/issues/9) |
| [#26 Cinematography: coordinate a repeatable camera path and gimbal](https://github.com/stacksjs/drone/issues/26) | [#10](https://github.com/stacksjs/drone/issues/10), [#8](https://github.com/stacksjs/drone/issues/8), [#9](https://github.com/stacksjs/drone/issues/9) |
| [#27 Environment: survey wildlife or atmosphere with traceable samples](https://github.com/stacksjs/drone/issues/27) | [#18](https://github.com/stacksjs/drone/issues/18), [#14](https://github.com/stacksjs/drone/issues/14), [#8](https://github.com/stacksjs/drone/issues/8) |
| [#28 Parity audit: expand the pinned upstream inventory into behavior-level coverage](https://github.com/stacksjs/drone/issues/28) | None |
| [#29 Pi AI Camera: complete on-device capture and loss-validation evidence](https://github.com/stacksjs/drone/issues/29) | None |

## Coverage scope

The [source inventory](upstream-inventory.json) accounts for **274 top-level entries**: 60 PX4 modules,
59 PX4 driver families and 155 ArduPilot libraries. Every entry has a pinned source URL, a tree hash,
status and a linked implementation/audit issue. Detailed hardware subdrivers, firmware parameters,
message variants and every behavioral edge are **not** implied by this directory inventory. The
parity issue expands that audit and requires executable evidence for every support claim.

The inventory pins PX4 `ddcaad6601be20453ec6acd0f08e567af3a7e1bb` and ArduPilot
`afeb9c4941543d97f3e04fecf257b8f598f49a6a`, researched October 17, 2026. It is a reproducible baseline,
not a claim to track every future upstream change. Run `bun run roadmap:check` to catch unmapped
entries, dangling issue links and dependency cycles in the retained snapshot.

See [the feature matrix](feature-coverage.md), [driver contract](../drivers.md), and
[the architecture decision](../adr/0001-owned-autonomy.md). External stack feature availability
varies by vehicle, firmware version, hardware and configuration. Their existence in an upstream
module does not mean this project's adapter exposes it.
