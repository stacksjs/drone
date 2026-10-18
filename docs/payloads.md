# Owned camera and payload adapters

Issue [#8](https://github.com/stacksjs/drone/issues/8) now has an owned camera acquisition path,
independent of ArduPilot and PX4. The Pi AI Camera adapter commands a new low-resolution frame,
verifies an acknowledged image, and associates its capture timestamp with the owned estimator.
Physical camera execution, wiring and calibration have **not** been validated. Other payloads
remain inventory and bus contracts. This slice does not enable physical flight or actuator writes.

## Try it with native Stacks commands

```sh
./buddy payloads:bench
./buddy payloads:bench --scenario wrong-identity
./buddy payloads:bench --scenario stale-clock
./buddy payloads:bench --scenario lost-ack
./buddy payloads:bench --scenario pose-reset
./buddy payloads:capture --driver replay --output /tmp/my-new-capture
bun run runtime:cli
./storage/runtime-build/cli/drone payloads:bench
```

The nominal bench synthesizes sensor records through our existing sensor pipeline and estimator.
It triggers once at 600 ms, captures at 620 ms, receives the ACK at 640 ms and associates the
620 ms snapshot. The position measurement and attitude epochs remain separately recorded.
The JPEG is an original synthetic 8x8 grey image. Fault scenarios report `rejected`, with exactly
one trigger and no automatic retry. Exit zero means the requested fault experiment completed;
inspect `outcome` for the result. Unknown scenarios exit nonzero.

`payloads:capture` requires an existing parent and a **new** output directory. It writes a private
`capture.jpg`, then `capture.json` as the completion marker, including SHA-256, byte length,
command/session/device identity, capture/ACK/receipt epochs, uncertainty and pose status. It
refuses existing directories, including symlinks, and never overwrites captures. An interrupted
write can leave an incomplete directory; preserve it for diagnosis and use a new directory.
This is local export, not durable flight logging or a cloud storage job.

## First physical adapter: Raspberry Pi 5 and IMX500

Use the Pi AI Camera and Pi 5 camera cable described in [camera setup](camera-tracking.md).
Power the Pi down before connecting the CSI ribbon; verify connector orientation against the
[Raspberry Pi camera documentation](https://www.raspberrypi.com/documentation/accessories/ai-camera.html).
Use the supported 64-bit Raspberry Pi OS packages and camera discovery steps from that guide.
Stop the existing `/camera` tracking session first. Each mode exclusively owns Picamera2;
this still adapter does not load an inference network and does not run concurrently with tracking.

On the Pi, explicitly request one physical acquisition:

```sh
./buddy payloads:capture --driver imx500 --output /home/pi/captures/first
# A compiled CLI outside the checkout needs the worker source location:
/path/to/drone payloads:capture --driver imx500 --project /home/pi/drone --output /home/pi/captures/second
```

The parent directory must already exist. The adapter requires Linux, exactly one discovered
IMX500, a matching model handshake and a unique worker boot identity. `DRONE_CAMERA_PYTHON`
can select the Python executable; the default is `/usr/bin/python3`. Python remains limited to
Picamera2/OpenCV acquisition, metadata and JPEG encoding. TypeScript owns capture policy,
validation, pose association, exports and CLI orchestration. Merely importing the adapter does
not open hardware. There is no HTTP capture endpoint or hardware actuator route.

The standalone physical command has **no live owned sensor connection**, so its manifest
explicitly reports an unavailable pose. It does not attach a replay position to a real image.
Applications can record their live owned-estimator snapshots into `createPayloadPoseTimeline()`
and pass it to `createPayloadCaptureSession({ adapter, poses })`. Pass `{ requirePose: true }`
to reject captures without qualified association. The shutter may already have fired when a
missing pose is discovered; rejection never means the physical capture was undone.

## Timing and bounded protocol

The dedicated `--payload` mode of `imx500_worker.py` uses version 1 NDJSON on local stdin/stdout.
Vendor diagnostics go to stderr. Startup has a 15 second deadline. A handshake reports session,
worker boot, actual camera device identity, model, evidence and dimensions. Each capture uses
one increasing uint32 sequence scoped to that session and boot. The parent first sends a `sync`
request; the child echoes that sequence with its monotonic timestamp. Parent send/receipt times
bound the offset and half-round-trip uncertainty. No common process clock origin is assumed.
There is one synchronization attempt and no shutter retry. A round trip over 10 ms is rejected
before sending a trigger; worker mapping plus round-trip uncertainty must fit the 5 ms budget.
The clock-rate relationship is assumed stable during the two-second transaction; this is not a
measured sensor timing calibration or a guarantee across suspension.

The parent then sends `capture` with conservative child-monotonic not-before and deadline
bounds. A fresh sync is mandatory. The worker captures 640x480 RGB888 at 15 Hz, uses finite
250 ms SDK request waits, discards queued/pre-trigger exposures and returns one JPEG at
quality 85. It releases every acquired request, including failed metadata/encoding paths, and cancels
pending SDK jobs before stopping and closing the camera after a request timeout.
`SensorTimestamp` names the first sensor row and uses Linux `CLOCK_BOOTTIME`; the worker
samples BOOTTIME inside a bracket of MONOTONIC reads to map it. It rejects missing/future
metadata, frames older than 500 ms and clock sampling uncertainty over 5 ms. The conservative
not-before check subtracts exposure duration and timing uncertainty. Exposure is retained in
microseconds. ACK time is after encoding, not shutter time.

The parent enforces a two-second capture deadline, one pending operation, at most 512 KiB of
JPEG and 750,000 characters per inbound buffer. It checks strict base64, JPEG envelope and
encoded dimensions, exact sequence/session/boot identity, ordered timestamps and uncertainty.
The JPEG header check is not a full pixel decoder or untrusted media sanitizer. A timeout,
malformed packet, stream exit, cancellation or explicit close retires the adapter and rejects
pending work. The parent sends SIGTERM and escalates to SIGKILL after one second; the Linux
worker also installs parent-death handling. An ambiguous shutter outcome is never retried.
Reopen explicitly to acquire a new camera session. Process evidence is a driver declaration,
not cryptographic attestation of physical hardware.

Primary contracts: [libcamera control definitions](https://github.com/libcamera-org/libcamera/blob/master/src/libcamera/control_ids_core.yaml)
and [Picamera2 request lifecycle](https://github.com/raspberrypi/picamera2/blob/main/picamera2/picamera2.py).
These references explain SDK contracts; they are not evidence that our Pi adapter was run.

## Pose association and calibration limits

The bounded timeline retains at most 128 snapshots and five seconds. It accepts only healthy,
current tilt and local NED position, finite normalized quaternion, valid origin/datum and
monotonic estimator epochs. It preserves IMU and GNSS measurement times and the position
prediction epoch. Replayed epochs, clock reversal, estimator reset, boot/evidence/origin changes
and unhealthy records invalidate in-flight association. Copies prevent later estimator mutation
from rewriting capture evidence. Hardware captures require handshake-backed estimator evidence;
fixtures require fixture evidence. Local clock and snapshot high-water marks survive clears.

Association selects the nearest qualified snapshot within 40 ms including camera clock
uncertainty, with attitude within 80 ms. It does not interpolate or extrapolate camera pose.
A newer ACK receipt must not replace exposure time. GNSS position may be predicted from a
measurement up to 1.5 seconds old; its original epoch remains visible. No snapshot qualifies
when no bounded match exists. Relative yaw is not absolute heading. Every result retains
`georeferenced: false`, `sensorTimingCalibrated: false`, `cameraExtrinsicsCalibrated: false`
and `physicalFlightEnabled: false`. Camera intrinsics, distortion, rolling shutter, lever arm,
boresight and absolute heading must be measured before survey georeferencing is claimed.

## Bus contracts and remaining payload inventory

`validatePayloadBus` validates configuration only. All bus contracts bound timeout to 2 seconds,
transfer to 512 KiB and queue depth to one. No generic bus executor is exposed. The GPIO, PWM
and DShot contracts include inactive/neutral settings; specifying them does not enable writes.
These are application configuration envelopes, not hard real-time guarantees from Linux.

| Contract | Configuration | Implementation |
| --- | --- | --- |
| CSI | IMX500 model and Pi connector | Camera acquisition adapter; physical test pending |
| SPI | Controller, chip select, mode, clock | Contract only |
| I2C | Controller, non-reserved 7-bit address, clock | Contract only |
| UART | Device and baud | Contract only |
| CAN / DroneCAN / Cyphal | Interface, bitrate, node ID | Contract only; no serialization/driver stack |
| GPIO | Chip, line, inactive level | Contract only |
| PWM | Frequency, minimum/maximum/neutral pulse | Contract only |
| DShot | 150/300/600 rate, zero neutral command | Contract only |
| Power monitor | Transport, voltage/current bounds, calibration ID | Contract only |

`payloadInventory` tracks camera, gimbals, LiDAR/rangefinders, thermal/multispectral cameras,
ESC telemetry, grippers/winches, relays/lights, transponders, sampling payloads and power monitors.
Candidate transports do not imply supported vendor devices. Their work remains under #8 and
its dependent domain issues, including [survey #18](https://github.com/stacksjs/drone/issues/18),
[LiDAR #19](https://github.com/stacksjs/drone/issues/19), [sampling #14](https://github.com/stacksjs/drone/issues/14)
and [gimbals #26](https://github.com/stacksjs/drone/issues/26).

## Acceptance still required on hardware

1. Record Pi/OS/SDK versions, actual IMX500 identity, cable/connector, power and thermal state.
2. Capture real images and paired live owned-estimator data. Measure first-row latency and clock
   offset under CPU load, dropped frames, suspension and worker/host restart using an independent
   reference such as a timestamped LED and logic analyser. Do not infer these from ACK receipt.
3. Measure camera intrinsics/distortion, exposure/rolling-shutter timing, body-to-camera mount,
   heading reference and pose error before metric imagery or survey collection.
4. Exercise missing/loose ribbon, wrong/multiple device, camera already owned, power interruption,
   encoding failure, process death, timeout and cancellation. Confirm resource release and no retry.
5. Gate any later bus/actuator driver on electrical wiring, power limits, neutral/reset behavior,
   bounded command/ACK tests and independent authority interlocks from #2/#3/#6.

The retained [fixture evidence](payload-evidence.json) records all five bench scenarios.
Tests cover a scripted real child-process transport, faulted camera fixtures, SDK
boundary stubs and the owned sensor/estimator path. None is physical camera, HIL or flight evidence.
