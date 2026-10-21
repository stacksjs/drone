# Owned runtime bench foundation

Issue [#2](https://github.com/stacksjs/drone/issues/2) now has a native kernel, a host HAL, a Pico 2
HAL and Stacks developer commands. Physical board validation remains open. This is a synthetic
sensor-to-neutral-output bench target, with no arming, PWM, flight modes or actuator values.

## Layout and ownership

- `firmware/runtime/`: original C++17 kernel, fixed binary protocol, host harness and Pico 2 HAL.
- `resources/functions/drone/runtime/`: TypeScript codec, Pi session, recorded-capture inspection,
  build orchestration and host bench runner. Mission/application policy remains TypeScript.
- `app/Commands/Runtime*.ts`: native `defineCommand()` commands, automatically discovered by Buddy.
- `bin/drone.ts`: the same Stacks command definitions in a standalone CLI. No separate argument parser.

The [language and board decision](https://github.com/stacksjs/drone/blob/main/docs/adr/0002-bench-runtime.md) records the firmware exception.
The Pico 2 is an additional development board, not the existing Pi 5 and not yet an approved
flight controller. Existing ArduPilot and PX4 drivers continue independently. This bench protocol
cannot be adapted into flight `Telemetry` from a synthetic scalar; flight integration needs real
sensors, estimation, controls and authority work in the linked roadmap.

## Run the native host harness

Requires Bun, CMake >= 3.20, a C++17 compiler and CTest on macOS or Linux. There are no fetched SDK
inputs for host builds. From the checkout:

```sh
./buddy runtime:build
./buddy runtime:bench --ticks 1000
./buddy runtime:bench --fault deadline
./buddy runtime:bench --fault stale
./buddy runtime:bench --fault expiry
./buddy runtime:bench --fault replay
./buddy runtime:bench --fault version
```

The bench runner compiles the original kernel and exchanges real frames with its native process.
Its virtual clock is explicit. The report identifies `host-harness` evidence, synthetic sample
counts, state size and failure outcome. `maxExecutionUs: 0` means no virtual execution delay was
injected; it is not measured MCU latency. CTest additionally checks execution overruns, timing
boundaries, clock rollback, identity/version rejection, reset state and ten thousand healthy ticks.
The same fixed-buffer UART state machine used by Pico is also exercised through a host I/O harness
for fragmentation, resynchronization, corruption, RX/TX budgets and pending transmit buffers.

Build a standalone CLI for the current platform:

```sh
bun run runtime:cli
./storage/runtime-build/cli/drone --help
./storage/runtime-build/cli/drone runtime:bench --project "$PWD" --ticks 1000
```

It can run outside the repository with `--project /absolute/path/to/drone`. Build tools and the
source checkout remain required. Compiled CLI startup disables automatic bunfig/dotenv/tsconfig
loading, so another directory cannot inject project preload modules. Native Stacks CLI commands
remain available through Buddy. `buddy build:cli` in the installed framework builds Buddy itself;
`runtime:cli` compiles our application entrypoint using Bun's executable build support.

## Reproduce the Pico 2 firmware build

Inputs are retained in [toolchain-lock.json](https://github.com/stacksjs/drone/blob/main/firmware/runtime/toolchain-lock.json): Pico SDK
2.3.1 at `079c6f39023649b154152db30f1d781e884879bc`, picotool's pinned commit and Arm GNU
14.3.Rel1 (GCC 14.3.1). Toolchain archives for macOS ARM64, Linux x86-64 and Linux ARM64 have
SHA256 pins. Obtain the matching archive from the retained vendor URL, verify its hash, then
extract it in a local tools directory. Do not install an arbitrary newer compiler for this profile.
CMake, Git, Python 3 and native host C/C++ build tools are also needed to build picotool.

```sh
git clone --branch 2.3.1 --depth 1 https://github.com/raspberrypi/pico-sdk.git /tmp/pico-sdk
# Set this to the extracted Arm GNU 14.3.Rel1 directory.
export PICO_TOOLCHAIN_PATH=/absolute/path/to/arm-gnu-toolchain-14.3.rel1-aarch64-arm-none-eabi
./buddy runtime:build --target pico2 --sdk /tmp/pico-sdk
```

The command rejects an incorrect or dirty SDK commit. CMake also checks the SDK revision and GCC
version. SDK sources are external, not vendored into this MIT repo. SDK/picotool are BSD-3-Clause;
Arm GNU distribution components retain their upstream licences. See the pinned release sources.
USB stdio and application heap usage are disabled; the missing TinyUSB-submodule warning is expected.
The build fetches the pinned picotool source for UF2 conversion when it is not already available.

Output: `storage/runtime-build/pico2/drone_runtime.uf2`, `.elf`, `.elf.map` and compiler `.su` files.
Build products and SDK checkouts are local state. The linker limits flash to 64 KiB and static RAM
to 8 KiB. The kernel is statically limited to 128 bytes and the UART state to 224 bytes (64-byte RX and 128-byte TX). The board
reserves a 4 KiB primary stack; `.su` reports are static analysis, not measured stack high-water.
Linker wrapping rejects ordinary malloc/calloc/realloc/free dependencies. There are no dynamic
containers, exceptions or RTTI in the kernel.

## Flash and observe a disabled-load board

Use a Pico 2, a USB data cable, a 3.3 V USB-UART adapter, common ground, a 10 kOhm pulldown and a
logic analyser. A debug probe is useful for inspecting stack and reset behavior. Connect no ESC,
servo, motor, relay, propeller or other load to this target.

1. Put the pulldown between GP15 (neutral test output) and ground. It maintains neutral while the
   MCU is reset or in BOOTSEL, when software cannot drive the pin. Measure GP15 and GP16 with the analyser.
2. Hold BOOTSEL while plugging the Pico 2 into USB. Copy the **Pico 2** UF2 to its boot mass-storage
   volume. The board reboots automatically. Flashing was not performed by this coding session.
3. The firmware keeps GP15 low. GP16 pulses once per scheduled tick and exposes execution time.
   Record the pulse intervals and high times. The target is 1000 us period, <=250 us start lateness
   and <=500 us execution. The core latches a failure if these bounds are exceeded.
4. Connect GP0 (UART0 TX) to the adapter RX, GP1 (UART0 RX) to adapter TX and common ground.
   Use **3.3 V logic**, 115200 baud, 8N1, no flow control. GP0/GP1 are names on the Pico, not the Pi.
   Periodic binary status is sent at 10 Hz. Command responses are queued without blocking the tick.
5. On Linux, configure the adapter and record receive-only evidence, substituting its real path:

```sh
stty -F /dev/ttyUSB0 115200 raw -echo -ixon -ixoff
# timeout normally exits with 124 after collecting three seconds.
timeout 3s cat /dev/ttyUSB0 > /tmp/runtime-uart.bin
./buddy runtime:inspect /tmp/runtime-uart.bin
```

Inspection caps input at 1 MiB, resynchronizes valid frames and reports discarded bytes. Recorded
frames cannot grant live authority. The TypeScript session supplies the Pi-side hello/lease codec;
physical UART command timing has not yet been validated. No CLI command here writes to hardware.

6. Power-cycle and reset the board. Verify GP15 remains neutral throughout, sessions are cleared,
   the boot token changes, and stale bytes cannot obtain a diagnostic lease.
7. Build a separate fault-injection image:

```sh
./buddy runtime:build --target pico2 --sdk /tmp/pico-sdk --watchdog-test
```

Flash `storage/runtime-build/pico2-watchdog/drone_runtime.uf2`. It deliberately stops executing
after two seconds. The hardware watchdog is configured for 100 ms and is not paused by debugging.
Measure the actual reset time and neutral pin level across the stall/reset; the next boot status
must set `watchdogReset`. The test image intentionally repeats this cycle. Reflash the normal image
when finished. There is no automatic flash or reset command in the CLI.

## Scheduler, memory and failure contract

The single-core loop uses the SDK microsecond timer and an absolute 1 kHz schedule. Each tick reads
a synthetic sample, keeps the test output neutral, processes at most 32 RX and 32 nonblocking TX bytes
and prepares at most one status frame. No serial write waits for the peer. Execution accounting
includes protocol/HAL work before the watchdog refresh; trace and watchdog overhead need measurement.
The watchdog is refreshed only after a healthy completed tick. Deadline/clock faults latch until
reset and stop watchdog feeding. Invalid frames revoke diagnostic authority but keep sampling neutral.

Boot/session identity, freshness, version mismatch, sequence exhaustion, lease expiry and invalid
capabilities are described in the [protocol specification](https://github.com/stacksjs/drone/blob/main/docs/runtime-protocol.md). There is no crypto
authentication: local UART is a trusted bench boundary. Network transport and physical flight authority
remain separate work. A diagnostic lease never changes GP15 from neutral.

## Evidence retained for this slice

- macOS ARM64: native CMake/CTest harness and TypeScript-to-C++ protocol/failure tests executed.
- Pico 2: cross-compilation and UF2 generation executed with the pinned SDK/compiler.
- Standalone CLI: compiled and exercised locally, including use outside the project directory.
- Board boot, UART capture, deadline timing, stack high-water and watchdog reset: **not measured**.
  Issue #2 remains open for those acceptance gates. No physical flight capability is claimed.

The [validation record](https://github.com/stacksjs/drone/blob/main/docs/validation.md) tracks the complete release checks, and the
[historical runtime build evidence snapshot](https://github.com/stacksjs/drone/blob/main/docs/runtime-evidence.json) records artifact hashes and static footprint. Add real bench captures,
logic-analyser measurements, exact board revision and stack/watchdog results before closing #2.

The optional [sensor bench profile](https://github.com/stacksjs/drone/blob/main/docs/sensors.md) adds bounded IMU, barometer and GNSS acquisition.
Its larger footprint must be checked separately from the historical synthetic-only snapshot.
