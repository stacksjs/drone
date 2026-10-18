# Validation evidence

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
- Native board runtime, estimation/controls and the domain workflows listed in the
  [replacement matrix](roadmap/feature-coverage.md). They remain planned work.

The scaffold warns that feature-stripped defaults differ from the installed full defaults. Build
output can warn about inherited unused image assets and an unset deployed sitemap domain. No cloud
deployment or physical autonomous flight was performed.
