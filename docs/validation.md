# Validation evidence

## Simulated multirotor control slice

- 131 Bun tests pass with 16,326 assertions, including 15 control/physics tests. The two native
  CTest contracts and five Python bridge tests also pass. Lint, application/runtime/view typechecks
  and roadmap validation passed. CPU-heavy physics tests have explicit wall-clock budgets.
- Independent quad-X force/moment, mass*g hover, NED demand signs, free-fall, rigid-body roll,
  motor time-constant and PID derivative/anti-windup cases verify equations independently of tuning.
- The owned closed loop passes 20-second hover, position-step, wind/torque-disturbance and additional
  sensor-delay scenarios without floor contact. Raw synthetic frames pass through the existing
  sensor pipeline/estimator; the controller receives no plant truth. Physics-step convergence is
  checked at 2 ms versus 4 ms. See [the reproducible report](controls-evidence.json).
- The IMU-loss run latches zero commands at 3060 ms, within 80 ms of capture loss, and stays inhibited
  after packets resume. The simulated vehicle falls; this verifies inhibition, not a landing controller.
- Estimator reset/origin/boot changes, mismatched rate epochs, clock/schedule faults, stale targets
  and invalid values inhibit commands. A real sensor-pipeline uncertainty regression verifies that
  an earlier healthy estimator snapshot cannot authorize a later control tick.
- Buddy and the standalone CLI use the same native Stacks command. Report regeneration matches the
  retained evidence. This is an invented vehicle model with initial heading assumed, 600 ms supported
  startup and gyro-only attitude propagation after initialization. No measured airframe, physical
  control, disabled-prop bench or #6 authority validation is implied.


## Owned estimator software slice

- 116 Bun tests pass with 14,892 assertions, including 19 estimator tests. The two native CTest
  contracts and five Python bridge tests also pass. Lint, application/runtime/view typechecks and
  roadmap validation passed.
- Native Stacks `estimator:replay` executes through Buddy and the compiled standalone CLI outside
  the checkout, including playback beyond EOF. Simulator playback is deterministic across chunk
  sizes and pause; estimator outputs stay separate from ideal flight telemetry.
- Published GeographicLib ECEF/local examples verify frame, ellipsoid height and NED sign
  conventions to the precision printed by the reference. Coupled analytic raw-register motion
  independently quantifies maximum/RMS errors; regeneration reproduces fixture files and report.
- The scripted six-second trajectory reports maximum Euler error norm 0.0061411 rad and maximum
  NED position error 0.0025786 m across 276 checks. These are synthetic-software regression values,
  not sensor accuracy or flight evidence. See [the retained report](estimator-evidence.json).
- Fault tests cover gyro yaw bias, IMU gaps/stationary realignment, invalid source/mount/noise,
  GNSS jumps/outage/reacquisition, altitude datum isolation, pressure reference reset, positive
  covariance blocks and board/consumer-clock resets. Qualified anchor corrections preserve board
  integration intervals while tightening mapped sample expiry.
- Absolute heading/navigation remain unavailable. Physical reference and compass-failure campaigns,
  full inertial EKF/fusion and a measured board port remain open in [#4](https://github.com/stacksjs/drone/issues/4),
  with issue #3 hardware calibration/timing prerequisites still open.


## Sensor bench slice

- Stacks replay/inspection commands and standalone CLI executed, including replay outside the checkout.
- Native register bus tests cover identity/configuration, data-ready, bus failure, forced pressure
  conversions, timeout recovery, UBX checksum/epoch/week rollover and actual DS codec round trips.
- Mixed DR/DS UART tests preserve complete frames under partial writes and prioritize awaited replies.
- Sensor tests cover SI values, right-handed mount axes, thermal corrections, diagonal variance,
  skew/future/stale/replayed data, independent ages, stuck/recovery, clock refreshes and EOF playback.
- The retained fixture is independently encoded scripted data, not a physical recording. Simulator
  sensor snapshots match direct replay, and replay continues to age after EOF without stopping motion.
- Both synthetic and sensor Pico 2 images cross-compiled with the pinned toolchain. The sensor image
  uses 20,440 text bytes, 836 BSS bytes and a 1,112-byte compiler-reported main stack frame. These
  are static build values, not measured hardware timing or stack high-water. See [build evidence](sensor-evidence.json).
- Lint, application/runtime/view typechecks, roadmap validation, native CTest and the Bun/Python
  suites passed: 97 Bun tests with 12,451 assertions, two native CTest contracts and five Python tests.
- Physical sensor capture, mounting/thermal/noise calibration, group-delay measurement and GNSS
  PPS/TIM-TP alignment remain open in [#3](https://github.com/stacksjs/drone/issues/3), along with
  issue #2's physical runtime evidence. No estimator or actuator authority is introduced.

## Owned runtime slice, October 17, 2026

- Native CMake/CTest contract passes for the same kernel used by the Pico HAL, including synthetic
  timestamps, state bounds, neutral state, lease expiry, stale/replayed/wrong-identity commands,
  timing boundaries, execution/lateness faults, clock rollback and safe reset state.
- Shared UART state-machine tests cover fragmented/noisy/corrupt input, bounded RX/TX work,
  nonblocking transmit and pending-frame preservation.
- TypeScript tests exchange actual wire frames with the native host process. The host uses a
  virtual clock; its reported zero execution time is not measured MCU latency.
- Independent Python struct/zlib fixtures verify CRC32 and little-endian wire fields.
- Stacks `runtime:build`, `runtime:bench` and `runtime:inspect` executed. The standalone CLI was
  compiled and exercised outside the repository with `--project`, including a recorded test fixture.
- Normal and deliberate watchdog-stall Pico 2 UF2 images cross-compiled using the retained SDK,
  picotool and Arm GNU compiler pins. Linker flash/static RAM assertions passed.
- `./buddy lint`, `./buddy typecheck`, `bun run typecheck:runtime`, view typecheck and roadmap
  check passed. The full suite passed 73 Bun tests with 12,282 assertions, plus native CTest and
  five Picamera2 bridge tests. Fourteen Bun tests cover the new runtime boundaries.
- Physical Pico boot/flash, actual UART operation, GPIO timing, stack high-water and watchdog
  reset measurements remain open in [#2](https://github.com/stacksjs/drone/issues/2).

## Previous camera and driver release

Camera and driver release, October 17, 2026. Local development used Bun 1.4.3 on macOS ARM64.
The initial simulator release had 31 tests; the checks below cover the expanded release.

## Executed

- `./buddy lint`: pickier through Buddy, zero errors/warnings.
- `./buddy typecheck`: application TypeScript check passed.
- `bun run typecheck:views`: three script blocks and 88 template expressions, zero errors/warnings.
- `./buddy test`: 59 tests across four files, 12,183 assertions. Covers the deterministic ten-minute
  ideal simulation, controller leases/envelope, GPS freshness/jumps, real loopback UDP, independent
  MAVLink fixtures, explicit camera selection, confirmation, ambiguity/loss, source failures,
  stale frames, session restarts, visual guards, process signal termination and generated registry loading.
- `python3 -m unittest discover -s tests/hardware`: five hardware-bridge contract tests without
  vendor packages, covering SSD class/confidence filtering, coordinate order/normalization,
  clipping, invalid tensors and bounds. Python compilation also passed.
- Independent pymavlink 2.4.50 fixtures cover v1/v2 heartbeat/velocity and current common.xml
  SYS_STATUS extension fields. The encoder matches the external v1 fixture; signed frames are refused.
- PX4 local UDP tests cover firmware identity/mode decoding, explicit zero-stream preparation,
  timing gaps, velocity transmission after preparation and physical receive-only restrictions.
- `bun run roadmap:check`: 274 pinned upstream entries mapped to 28 acyclic implementation issues.
  All 66 planned issue blockers were linked through GitHub's native dependency API.
- `./buddy build views`: two static pages built successfully.
- Registered camera API: valid authenticated commands return 200, missing bearer returns 401,
  malformed authenticated JSON returns 400 and a one-megabyte whitespace command returns 413.
  Unauthorized malformed/oversize bodies return 401 before parsing.
- Real Chromium scenarios: explicit selection confirms tracking; lost/ambiguous detections latch
  loss; restored detections stay lost until reselection. Clear and stop return to idle. No console
  errors or failed requests. These scenarios passed at 320, 428, 768, 1280 and 1920 px widths,
  with no horizontal overflow. Desktop and mobile captures were visually inspected.
- The existing simulator UI's movement, failure, recovery, pause and settings scenarios passed
  during the initial release, along with terminal simulation and receive-only telemetry startup.

The product is an operator workspace. Applicable Stacks design preflight checks cover responsive
layout, dark theme/accent consistency, readable controls, keyboard focus, form validation,
reduced-motion policy, stx boundaries and honest state labels. Camera replay is visibly schematic.
No real camera footage or physical flight state is fabricated. Marketing-only hero requirements
are not applicable. Newly authored visible copy uses no em-dash or separator en-dash.

## Not yet executed

- Pi ARM64 runtime installation, camera capture/inference, power/thermal measurements or measured
  acquisition latency. [On-device validation](https://github.com/stacksjs/drone/issues/29) is open.
- Complete ArduCopter or PX4 SITL flights, including real mode-transition and loss/fallback campaigns.
  Local UDP/protocol tests do not establish complete simulator integration.
- Firmware flashing, sensor calibration, RC link, actuator outputs or physical airworthiness tests.
- Authenticated paired GNSS transport or calibrated metric visual-position fusion.
- Board-validated runtime, estimation/controls and the domain workflows listed in the
  [replacement matrix](roadmap/feature-coverage.md). They remain planned work.

The scaffold warns that feature-stripped defaults differ from the installed full defaults. Build
output can warn about inherited unused image assets and an unset deployed sitemap domain. No cloud
deployment or physical autonomous flight was performed.
