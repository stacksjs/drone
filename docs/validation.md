# Validation evidence

Initial release, October 17, 2026. Local development used Bun 1.4.2/1.4.3 on macOS ARM64.

## Executed

- `./buddy lint`: pickier through Buddy, zero errors/warnings after fixes.
- `./buddy typecheck`: application TypeScript check passed.
- `bunx --no-install stx typecheck 'resources/**/*.stx'`: two script blocks and 45 template expressions, zero errors/warnings.
- `./buddy test`: 31 tests across two files, including a deterministic ten-minute ideal simulation,
  target identity and freshness, failures, controller leases, GPS jumps and real loopback UDP.
- Independent MAVLink fixtures generated with pymavlink 2.4.50 for v1/v2 heartbeat and velocity.
  The encoder matches the external v1 fixture byte-for-byte; signed packets are refused.
- `./buddy build views`: one static page built successfully.
- `bun run simulate` and `./buddy drone:simulate`: terminal demonstrations completed.
- `bun run telemetry`: receive-only listener started successfully without a controller attached.
- HTTP `GET /api/drone/capabilities`: 200 and actual configured limits, physical flight disabled.
- Real Chromium scenario: run simulation, observe velocity, lose target, observe hold; no console
  errors or failed requests. Settings changes, low battery, recovery and pause also passed a second browser scenario.
- Responsive Chromium captures: 320, 428, 768, 1280 and 1920 px widths, no horizontal overflow.
- Full desktop and mobile screenshots visually inspected. Visible text uses no em-dash or separator en-dash.

The product is a cockpit workspace rather than a marketing landing page. Applicable Stacks design
preflight checks cover responsive layout, consistent dark theme and accent, readable labels/controls,
keyboard focus, form validation, reduced-motion policy, stx script boundaries and honest state labels.
Marketing-only requirements such as hero photography, marquees and logo walls do not apply.

## Not yet executed

- Raspberry Pi ARM64 runtime installation or power/thermal measurements.
- A complete ArduCopter SITL flight. The wire adapter has local UDP and independent protocol tests only.
- Flight-controller firmware flashing, sensor calibration, RC link or actual hardware testing.
- Real GPS target transport, authentication, camera capture, inference or identity tracking.
- Physical autonomous flight, collision avoidance, endurance or airworthiness validation.

The scaffold emits a warning that feature-stripped defaults differ from the installed full defaults.
Build output can warn about inherited unused image assets and an unset deployed sitemap domain;
these do not establish a deployed site. No cloud deployment was performed.
