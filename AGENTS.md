# Drone agent guidance

This is the `stacksjs/drone` Stacks application. Read `README.md` for implemented boundaries,
`docs/architecture.md` for the flight contract, and `docs/hardware.md` for hardware assumptions.

## Layout

- Keep drone functions and public types under `resources/functions/drone/`.
- Keep reusable stx components under `resources/components/` and pages under `resources/views/`.
- Use native Stacks Actions, typed routes, and Buddy commands for application entrypoints.
- `storage/framework/defaults/` is framework-owned. Add app overrides instead of editing it.
- Read relevant bundled skills in `storage/framework/defaults/ai/skills/` before non-trivial framework work.

## Required conventions

- TypeScript and Bun >= 1.4.2. Use pickier through `./buddy lint` and `./buddy lint:fix`, never ESLint directly.
- stx templates and ts-css utilities only. No vanilla DOM globals in stx scripts, no extra icon or motion packages.
- Imported TypeScript modules explicitly import their dependencies. Browser entry bindings do not leak into modules.
- `better-dx` supplies shared dev tooling; do not redeclare its tools. Keep Bun's hoisted linker.
- No `catalog:` dependency ranges. Dependency updates belong to buddy-bot.
- No em-dash or separator en-dash in newly authored visible copy.
- Before finishing run `./buddy lint`, `./buddy typecheck`, `./buddy test` and relevant browser scenarios.
- Test behavioral seams: decision input/output, controller lifecycle, real local UDP and protocol fixtures.
  Do not claim physical or SITL flight validation from unit tests.

## Owned autonomy direction

- The destination is our own runtime, estimation, controls and mission engine. Read `docs/adr/0001-owned-autonomy.md`.
- ArduPilot and PX4 remain optional drivers. Do not make domain workflows depend on either firmware.
- `docs/roadmap/` distinguishes actual support from planned work and maps pinned upstream entries to issues.
- The only Python application exception is the small Picamera2 hardware acquisition helper. Keep tracking policy and application logic in TypeScript.

## Flight boundaries

- Physical telemetry is receive-only. Do not silently add arming or actuator endpoints.
- Preserve the independent flight-controller and RC authority model.
- Keep target selection explicit. Never switch people when a target is lost.
- Freshness uses one local monotonic clock. Check upstream fix age and replay at transport boundaries too.
- Use LOCAL_NED consistently and document the fixed origin. Down is positive in vectors.
- Keep UDP out of browser barrels. Signed frames need a real verifier before they can be accepted.
- Any future physical control work must update failure tests and document measured hardware evidence.

## Git

Branch with `codex/` before editing main. Use conventional commits, Chris Breuer
`chris@stacksjs.com`, and no coauthor trailers. Integrate current `origin/main` and
publish completed authorized work with a normal fast-forward push; never force-push.
Do not commit `.env`, credentials, real flight location logs, or machine-local runtime state.
