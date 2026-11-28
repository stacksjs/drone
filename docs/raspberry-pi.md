# Raspberry Pi 5 bring-up

Target: Pi 5, 8 GB, Raspberry Pi OS Lite 64-bit. Use Ethernet for the first bench session.
Keep propellers removed during bench integration. This release receives physical telemetry only.
Track the first aircraft setup and measured bench results in the [commissioning issue](https://github.com/stacksjs/drone/issues/112).

1. Install the Active Cooler, microSD and camera cable with power disconnected. Image the card using
   Raspberry Pi Imager, enable SSH with your own key and a non-default account, then boot on the official
   bench power supply. Identify the board with `cat /proc/device-tree/model`.
2. Install Bun for Linux ARM64 using the [official Bun installation instructions](https://bun.sh/docs/installation).
   Use Bun 1.4.4 and check `bun --version` before installing dependencies. Install Git through the
   OS package manager. Use a service account with serial-device access for receive-only telemetry.
3. Clone `https://github.com/stacksjs/drone`, then `bun install --frozen-lockfile`, copy `.env.example`
   to `.env` and run `./buddy key:generate`. Run `bun run simulate` before connecting a flight controller.
4. Validate the camera independently with Raspberry Pi's [AI Camera guide](https://www.raspberrypi.com/documentation/accessories/ai-camera.html)
   or [camera software guide](https://www.raspberrypi.com/documentation/computers/camera_software.html).
   `rpicam-hello --list-cameras` lists detected cameras. The [camera pipeline](camera-tracking.md) now consumes IMX500 frames/detections; its on-device validation remains pending.

Before connecting an airframe, verify the source installation on the Pi with the checked-in
fictional farm requests. Each collection writes a new private destination.

```sh
uname -m
bun --version
./buddy farming:plan examples/farming-plan.json
check_dir=$(mktemp -d)
./buddy farming:collect examples/farming-collection.json "$check_dir/collection"
test -f "$check_dir/collection/attempt/manifest.json"
```

Expect `aarch64`, Bun 1.4.4 or later, a planning preview and a completed synthetic collection
with `physicalFlightEnabled: false`. Run `./buddy dev --frontend` to open `/mapping` and
`/agriculture` on the frontend. A Pi installation check does not verify the camera, power,
telemetry or bundled aircraft configuration. Record those observations when commissioning the kit.

## Owned runtime development

Continue with the [owned runtime bench](runtime.md#run-the-native-host-harness),
using its CMake, C++17 and CTest prerequisites on a development host. The host
harness exercises the kernel and Pi protocol with synthetic samples and neutral
outputs. Follow the separate Pico 2 and [sensor bench](sensors.md) guides when
adding those boards. Pi camera acquisition and physical board measurements still
need their own on-device validation. ArduPilot and PX4 are optional drivers.

## Optional flight-controller telemetry

Use this path when you want receive-only telemetry from an independent flight
controller. It is separate from developing the owned runtime and does not enable
physical flight commands.

5. Keep the X500 kit's supplied PX4 firmware for the initial telemetry check, or use the
   matching ArduCopter profile if the Pixhawk already runs ArduCopter. Connect the autopilot
   to the Pi over USB using the exact connector on your board, then identify its
   stable `/dev/serial/by-id/...` device. Grant the service account the OS's serial-device permissions.
6. Open the controller directly with the Pi's Linux serial receiver. Close other programs using
   that tty first. The receiver uses the OS's `/usr/bin/stty` to configure the port.

   ```sh
   ./buddy telemetry:receive px4 --serial /dev/serial/by-id/YOUR_CONTROLLER
   ```

   Replace the device path with the actual USB identity. The default serial settings are
   115200 baud, 8 data bits, no parity, one stop bit and no flow control. Select `--baud`
   to match a rate required by the endpoint. The receiver uses a read-only descriptor and sends no
   MAVLink bytes. It prints JSON once per second and reports the oldest component receipt time, or
   `null` while a component is missing. A disconnect ends the session. After reconnecting the device,
   run the command again to establish a new telemetry scope.

   Where a local router already owns the tty, use `./buddy telemetry:receive px4 --port 14551` with
   its existing loopback UDP feed.
7. Ensure HEARTBEAT, SYS_STATUS and LOCAL_POSITION_NED arrive at suitable rates. A bench controller
   may have no local EKF position. That is an expected unavailable estimate, not permission to invent it.
   The receiver expects system/component IDs 1/1. Use `./buddy telemetry:receive ardupilot` for
   ArduCopter. See the [driver contract](drivers.md) for firmware-specific mode interpretation.
8. After bench operation works, design and inspect the fused regulated Pi power harness and mechanical
   mounting. Measure loaded voltage, current, thermal behavior and centre of gravity. Check the Pi's
   undervoltage/throttling diagnostics under CPU and camera load before considering flight.

## Wiring responsibilities

- Battery XT60 feeds the supplied flight-controller power module and airframe power distribution.
- A separate protected regulator branch supplies the Pi. The Pixhawk telemetry port does not power it.
- Receiver uses the Pixhawk's documented full UART/CRSF wiring and correct supply voltage; do not plug
  CRSF UART wires into an SBUS-only socket. Configure and verify the matching serial protocol through
  current [ArduPilot CRSF documentation](https://ardupilot.org/copter/docs/common-crsf.html).
- USB carries Pi/autopilot data. Avoid feeding one supply backwards through the other's USB VBUS.
- Camera uses the Pi CSI connection. Keep its ribbon away from propellers, power wiring and vibration.
- GPS/compass mount away from high-current wiring and magnets. Calibrate after the final mounting.

The Pi application is not automatically started at boot in this release. Build a supervised service
with explicit device permissions, logging and watchdog behavior only after the bench integration is
reproducible. Do not expose MAVLink UDP or actuator APIs to the Internet.
