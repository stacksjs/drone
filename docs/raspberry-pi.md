# Raspberry Pi 5 bring-up

Target: Pi 5, 8 GB, Raspberry Pi OS Lite 64-bit. Use Ethernet for the first bench session.
Keep propellers removed during bench integration. This release receives physical telemetry only.

1. Install the Active Cooler, microSD and camera cable with power disconnected. Image the card using
   Raspberry Pi Imager, enable SSH with your own key and a non-default account, then boot on the official
   bench power supply. Identify the board with `cat /proc/device-tree/model`.
2. Install Bun for Linux ARM64 using the [official Bun installation instructions](https://bun.sh/docs/installation).
   Check `bun --version` is at least 1.4.2. Follow the OS's current supported package workflow for Git
   and Python if using MAVProxy; do not run arbitrary project services as root.
3. Clone `https://github.com/stacksjs/drone`, then `bun install --frozen-lockfile`, copy `.env.example`
   to `.env` and run `./buddy key:generate`. Run `bun run simulate` before connecting a flight controller.
4. Validate the camera independently with Raspberry Pi's [AI Camera guide](https://www.raspberrypi.com/documentation/accessories/ai-camera.html)
   or [camera software guide](https://www.raspberrypi.com/documentation/computers/camera_software.html).
   `rpicam-hello --list-cameras` lists detected cameras. This project does not yet consume frames or detections.
5. Install the supported ArduCopter firmware for Pixhawk 6C using an appropriate ground station.
   Connect the autopilot to the Pi over USB using the exact connector on your board, then identify its
   stable `/dev/serial/by-id/...` device. Grant the service account the OS's serial-device permissions.
6. Use a maintained MAVLink router or MAVProxy to forward common telemetry to `127.0.0.1:14551`.
   For example, with MAVProxy installed in an isolated Python environment:

   ```sh
   mavproxy.py --master=/dev/serial/by-id/YOUR_CONTROLLER --baudrate=115200 --out=udp:127.0.0.1:14551
   bun run telemetry
   ```

   Replace the device path. USB serial commonly ignores the baud-rate setting; UART does not.
   The script prints JSON once per second and transmits no commands. An incomplete telemetry stream
   retains a missing/stale receipt timestamp, so it cannot pass a controller's freshness gate.
7. Ensure HEARTBEAT, SYS_STATUS and LOCAL_POSITION_NED arrive at suitable rates. A bench controller
   may have no local EKF position. That is an expected unavailable estimate, not permission to invent it.
   Confirm system/component IDs if not the default 1/1. PX4 mode decoding is not implemented.
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
