# Contributing to Drone

Start with README.md and AGENTS.md. The drone library lives in resources/functions/drone,
components in resources/components, and guides in docs. Framework defaults are not application code.

Use TypeScript, stx and ts-css. Run ./buddy lint, ./buddy typecheck, ./buddy test and the stx template
check. Add behavior tests at public interfaces and independently derived protocol fixtures when needed.
Never describe a unit test or kinematic simulation as a hardware flight validation.

Open a conventional-commit pull request explaining the behavior, verification, and actual hardware
boundaries. Physical command adapters require a separately documented integration and validation effort.
