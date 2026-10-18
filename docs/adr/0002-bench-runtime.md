# ADR 2: A native bench runtime with a Stacks toolchain

Status: accepted implementation direction for issue #2, October 17, 2026.

## Decision

Use a Raspberry Pi Pico 2 (RP2350, Arm Cortex-M33) as the first development-board candidate.
It is separate from the existing Pi 5. Use C++17 for the small allocation-free board kernel and
HAL under `firmware/runtime/`, with no exceptions, RTTI, dynamic containers or application heap.
This is an explicit firmware-language exception recorded before implementation. TypeScript and
Stacks continue to own mission logic, protocol validation, bench orchestration and CLI commands
under `resources/functions/drone/runtime/` and `app/Commands/`.

Use Pico SDK 2.3.1, commit `079c6f39023649b154152db30f1d781e884879bc` (BSD-3-Clause).
Our original kernel/HAL is MIT; the SDK remains an external dependency with its own notices.
Build the same kernel against a host test HAL and the Pico HAL. Do not emulate the native kernel
in TypeScript. Keep the first board profile synthetic-sensor and neutral-output only, with no
arming, PWM, motor allocation or flight command capability.

The candidate supplies a microsecond hardware timer, UART, GPIO and hardware watchdog using the
vendor SDK. Select it provisionally for a small reproducible bench target, not as an approved
flight-controller design. Retain issue #2 until measured board timing, stack high-water, safe
reset and watchdog evidence support the selection. Host measurements cannot supply that evidence.

## Initial contract

- One core, a 1 kHz foreground loop and fixed-size protocol buffers.
- A timestamped synthetic sample and a GPIO that stays at the documented neutral low level.
- A separate trace pin for observing loop execution without connecting an actuator.
- A 100 ms hardware watchdog, refreshed only after a completed healthy tick.
- A versioned fixed-length CRC-protected local UART protocol, per-boot/per-host session tokens,
  monotonic sequences and board-clock freshness checks. Tokens provide replay separation, not
  authentication against a physically connected attacker.
- A bounded bench lease changes only a diagnostic state. Every output remains neutral even when
  leased. Deadline faults latch until reset. No flight `Telemetry` is fabricated from a synthetic sample.
- Stacks commands build and exercise the kernel. Flashing stays a documented physical bench step.

## Evidence required

Commit the protocol, reproducible builds, cross-language host harness and failure tests. Record
actual cross-compilation and host results separately from the still-required board procedure.
Use the hardware results to retain or replace this board before native flight-control work.

Sources: [Pico 2 specifications](https://www.raspberrypi.com/products/raspberry-pi-pico-2/),
[Pico SDK release](https://github.com/raspberrypi/pico-sdk/releases/tag/2.3.1),
[hardware timer and watchdog APIs](https://www.raspberrypi.com/documentation/pico-sdk/hardware.html),
[official C/C++ SDK setup](https://www.raspberrypi.com/documentation/microcontrollers/c_sdk.html).
