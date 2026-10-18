# Pi AI Camera tracking

Implemented: an IMX500/Picamera2 acquisition bridge, TypeScript image-space tracking, explicit target
selection, short-term continuity confirmation, loss latching, preview, and an authenticated Stacks operator UI.
Physical camera operation still needs the on-device validation issue. No Pi or camera is connected to
the development machine used for this implementation.

## Start on your Pi 5

Install current Raspberry Pi OS 64-bit packages using the [official AI Camera guide](https://www.raspberrypi.com/documentation/accessories/ai-camera.html):

```sh
sudo apt update
sudo apt install imx500-all python3-picamera2 python3-opencv
```

Follow the official reboot/firmware setup instructions. This bridge supports only the installed
`imx500_network_ssd_mobilenetv2_fpnlite_320x320_pp.rpk` model under `/usr/share/imx500-models/`.
It expects that model's postprocessed boxes/scores/COCO classes, with person class 0. Arbitrary RPK
models have different tensor contracts and are deliberately not accepted as user-selected paths.

Generate a unique local operator secret, for example:

```sh
bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"))'
```

Save that value as `DRONE_CAMERA_TOKEN` in your ignored `.env`, or export it before starting Buddy.
Do not commit the token. Start `./buddy dev`, open `/camera`, and enter the same secret. Choose
**Start Pi AI Camera**, wait for firmware loading and fresh inference, then select a displayed person.
For development without a camera, choose **Start replay**. Replay is labelled as a schematic and does
not pretend to supply camera footage. Use SSH forwarding for remote access; if using a network service,
put it behind authenticated HTTPS. The raw camera API is not intended as a public service.

The worker uses `/usr/bin/python3` and OS-provided Picamera2/OpenCV. A trusted server administrator may
set `DRONE_CAMERA_PYTHON` to another compatible interpreter. No request can change the executable or
model path. Avoid pip-overriding Raspberry Pi's NumPy/libcamera stack inside the OS interpreter.

## Selection and loss semantics

1. New detections only populate selectable candidates. They do not choose a target.
2. Selection is bound to a session epoch, frame sequence and candidate token. Recent displayed frames
   are associated through intervening frames so normal UI/processing latency does not select a new box.
3. Three consistent observations confirm a lock. Matching uses image overlap, bounded centre displacement,
   area ratio and confidence. It is a conservative geometric association, not biometric identity.
4. No plausible match, multiple plausible matches, poor confidence, malformed data, source failure,
   clock discontinuity or more than 500 ms without fresh inference invalidates the lock.
5. A lost lock stays lost even after people reappear. The operator must explicitly select again.
6. Stop clears the session and selection. A restart gets a new epoch; old clicks and callbacks cannot
   choose a candidate in the new session.

Geometric association can drift to a visually overlapping person without a detectable ambiguity.
This implementation does not guarantee human identity through occlusion or crossings. Appearance-based
tracking and measured re-identification behavior are separate roadmap work. It does not identify names,
store face templates, or record images to disk by default.

## Freshness and hardware contract

The worker captures a Picamera2 request, reads its sensor timestamp and IMX500 inference frame counter,
extracts detections, maps boxes through `convert_inference_coords`, encodes a bounded 640 x 480 JPEG,
and emits one NDJSON packet for each new inference result. Repeated inference counters and absent
output tensors do not refresh detections. Every camera request is released, including error paths.

The exported Picamera2 `CnnOutputTensorInfoExported` structure supplies the counter. Its ABI is checked
explicitly; a missing/incompatible structure fails rather than fabricating fresh inference. This needs
hardware validation against the exact installed Picamera2/firmware versions.

On Linux, sensor age uses CLOCK_BOOTTIME, then the packet records the equivalent CLOCK_MONOTONIC
capture time. The TypeScript consumer compares that with the same host's monotonic clock to include
worker/pipe queue delay, then converts to its local `performance.now()` domain. Old, future, oversized
or malformed packets fail the source. This protocol is for a local child on the same Pi, not remote
machines. No Python/TypeScript wall-clock comparison is used for target freshness.

Picamera2 is the small hardware-language exception. Selection policy, tracking, sessions, API, UI,
protocol validation and all drone logic remain TypeScript under `resources/functions/drone/`.

## API and motion boundary

`GET /api/camera/state` and `POST /api/camera/command` require an explicit bearer token even in
local development. Tokens are not accepted in cookies or URLs. Responses are private/no-store.
Commands are start, stop, select, clear and replay-only fault injection. The JSON mutation Action
skips cookie CSRF because it accepts only explicit bearer authorization and uses no cookie authority.
It authenticates before reading the body and limits the original UTF-8 stream to 2048 bytes.

The browser stores its token in memory, polls without caching, and discards responses from older
requests after a command or disconnect. Disconnect closes the tab connection; **Stop source** stops
the shared source for all operators. Single-operator arbitration and leases are future work.

A confirmed observation contains normalized horizontal/vertical image errors. It supplies no position
in metres, depth, velocity, heading, camera calibration or GNSS coordinates. It is deliberately not
assignable to the flight `Target` interface. On loss, observation is null. To use a visual lock as an
additional motion interlock, wrap it with `createVisualLockGuard` and pass that guard to the controller
while supplying an independently calibrated/paired metric target. No web command here arms or moves a vehicle.

References: [Raspberry Pi AI Camera documentation](https://www.raspberrypi.com/documentation/accessories/ai-camera.html),
[official Picamera2 IMX500 helper](https://github.com/raspberrypi/picamera2/blob/main/picamera2/devices/imx500/imx500.py),
[official object detection example](https://github.com/raspberrypi/picamera2-examples/blob/main/examples/imx500/imx500_object_detection_demo.py).
