# Sensor bench, calibration and replay

Issue [#3](https://github.com/stacksjs/drone/issues/3) now has native register acquisition, a typed
sensor stream, calibration/health processing and simulator replay. This is bench software.
No attached IMU, barometer or GNSS receiver was captured during implementation.

## Native Stacks entrypoints

```sh
./buddy sensors:replay tests/fixtures/sensors/bench-v1.json --at-ms 500
./buddy sensors:replay tests/fixtures/sensors/bench-v1.json --at-ms 1500
./buddy sensors:inspect /tmp/sensors-uart.bin
bun run runtime:cli
./storage/runtime-build/cli/drone sensors:replay tests/fixtures/sensors/bench-v1.json
```

The commands use `defineCommand()` and the same Stacks command definitions in Buddy and the
standalone CLI. Replay/inspection cap files at 1 MiB. Dataset validation rejects unordered receipts,
incompatible evidence/clock labels and records outside the fixed wire format. No CLI command
writes to a physical device. `sensors:inspect` reads a raw mixed DR/DS UART capture and reports
CRC-valid packets without inventing a synchronized host clock.

The fixture is scripted register data at latitude/longitude zero. Its calibration profiles are
labelled `fixture`. Regenerate it with `bun tests/fixtures/sensors/generate.ts`. The generator uses
DataView and Bun's independent CRC32 implementation, not the application codec. It models UART
serialization at 115200 baud; this is not hardware latency evidence.

## Pico 2 acquisition profile

Keep the [runtime toolchain setup](https://github.com/stacksjs/drone/blob/main/docs/runtime.md) and disabled-load wiring. Build a separate image:

```sh
./buddy runtime:build --target pico2 --sensors --sdk /path/to/pico-sdk --toolchain /path/to/arm-gnu-toolchain
```

Output: `storage/runtime-build/pico2-sensors/drone_runtime.uf2`. The default image remains synthetic.
GP15 stays neutral low and GP16 is the loop trace. Retain the external GP15 pulldown across reset.
The sensor image uses the existing 1 kHz loop, 500 us execution deadline and 100 ms hardware watchdog.
The additional HAL work is included before the watchdog refresh. Cross-compilation does not prove
that sensor/bus timing meets the deadline.

| Device | Pico pins and settings | Profile behavior |
| --- | --- | --- |
| ICM-42688-P breakout, 3.3 V logic | SPI0 GP2 SCK, GP3 MOSI, GP4 MISO, GP5 CS; mode 0, 8 MHz | WHO_AM_I 0x47, explicit big-endian output, ±16 g/±2000 deg/s, low-noise 1 kHz; one 14-byte burst after data-ready |
| BMP280 breakout, address 0x76 | I2C0 GP8 SDA, GP9 SCL; 400 kHz | ID 0x58, factory trim, x1 temperature/pressure forced conversions at 10 Hz; no conversion wait inside the tick |
| u-blox M10-class receiver with NAV-PVT | Receiver TX to GP21/UART1 RX, common ground, 3.3 V logic | Configure externally for 115200 8N1, NAV-PVT at 1..5 Hz; receive only, no receiver configuration commands |
| Pi/USB-UART telemetry | GP0 TX, GP1 RX, common ground | DR v1 runtime status plus DS v1 sensor records, 115200 8N1 |

Use breakouts with documented voltage, pin mapping and pullups. Chip-level pins are not a complete
bare-chip wiring guide. The barometer profile accepts BMP280, not BMP390 or BME280. SPI/I2C
sensor initialization failures produce error records or missing data; there is no fake-data fallback.
GNSS silence produces a missing/dropout state. Keep the sensor assembly separate from all loads.

IMU acquisition is decimated to at most 50 telemetry records/s. Pressure is at most 10/s and GNSS
at most 5/s: 65 x 128 bytes/s plus 10 x 64-byte runtime status frames is below the nominal 11520
bytes/s capacity. Excess replies or burst traffic can still cause drops. Each source has one pending
record; replacing it sets `stream-overrun`. Pending sources rotate fairly after runtime replies.
No unbounded queue or blocking serial output is added. I2C transactions have bounded timeouts.
SPI uses the SDK peripheral transfer; the hardware watchdog remains the fallback for a stuck call.

## DS v1 wire contract

All integers are little-endian, except the raw IMU register payload, which preserves sensor big-endian
order. A DS frame is 128 bytes; unused payload bytes are zero. DR v1 remains a separate 64-byte format.

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 2 | Magic `DS` |
| 2 | 1 | Version 1 |
| 3 | 1 | Kind: IMU=1, barometer=2, GNSS=3 |
| 4 | 4 | Nonzero per-source sequence; no wrap within a boot |
| 8 | 8 | Runtime boot token |
| 16 | 8 | Board monotonic capture/trigger/first-receipt time, us |
| 24 | 8 | Board read-completion time, us |
| 32 | 4 | Flags: valid=1, bus error=2, pending overrun=4, estimated timestamp=8, reversed source time=16, unvalidated timing=32 |
| 36 | 2 | Logical device instance, currently equal to kind |
| 38 | 2 | Payload length: 16, 30 or 80 |
| 40 | 4 | Capture uncertainty, us; UINT32_MAX means unknown measurement-epoch uncertainty |
| 44 | 80 | Payload and zero padding |
| 124 | 4 | CRC32/ISO-HDLC of bytes 0..123 |

IMU: TEMP/ACCEL_XYZ/GYRO_XYZ registers (14 bytes), then gyro/accel configuration bytes, both 0x06.
Pressure: six ADC bytes from 0xF7, then 24 factory trim bytes from 0x88. GNSS: first 80 bytes of a
CRC/checksum-verified 92-byte NAV-PVT payload. The last 12 NAV-PVT bytes are unused by this profile.
The native parser checks the full UBX checksum before publishing. Repeated iTOW does not publish a
new frame; reversed epochs are flagged except for a bounded GPS-week rollover.

Device IDs are logical profile instances within a boot. The chip family and bus mapping are fixed by
this profile; no unique sensor silicon serial number is claimed. Bind measured calibration records
and physical mounting to the correct assembly before using them. Automatic cross-board binding
is not implemented.

## Units, calibration and quality

`createSensorPipeline()` consumes decoded wire records against an explicit clock anchor and optional
calibration set. The calibration input is cloned and validated before use. IDs/provenance, finite
coefficients, temperature domain, scales, noise and mount orientation are checked.

- IMU: °C, specific force m/s² and angular rate rad/s. Bias and linear residual thermal bias are
  subtracted in sensor axes, then scale and a proper signed axis permutation map to BODY_FRD.
  Reflections are rejected. Specific force includes the gravity response; it is not linear acceleration.
  Full-scale conversion uses the configured nominal range divided by 32768, pending measured scale.
- BMP280: factory integer compensation uses per-device trim and BigInt intermediates, then optional
  residual pressure offset/thermal correction. Output is Pa/°C. Zero/sentinel trim, skipped conversions
  and out-of-range results are rejected. The known reference vector produces 25.08 °C and
  100653.25390625 Pa. Factory compensation is distinct from measured field calibration.
- GNSS: latitude/longitude in degrees, distinct ellipsoid/MSL heights in metres, NED velocity in m/s,
  GPS iTOW in ms. 3D fix validity, invalid-LLH flags, satellite count and accuracy fields are checked.
  Repeated/reversed navigation epochs cannot be hidden by fresh transport timestamps.
- Covariance: separate diagonal variances for acceleration/angular rate, scalar pressure variance,
  and GNSS NED position/velocity accuracy estimates. IMU noise is scaled and permuted with the mount.
  GNSS horizontal accuracy is conservatively used for both N/E diagonal estimates. Correlations,
  calibration uncertainty and full covariance estimation are not modeled. Missing noise calibration
  is explicitly `covariance-unknown`, not zero variance.

Every source has independent age and stuck/dropout state. Default age limits are 80 ms IMU,
300 ms pressure and 1500 ms GNSS. A packet sequence never refreshes an old capture timestamp.
Exact repeated raw IMU/pressure values over 500/2000 ms flag `stuck-suspected`. This is a diagnostic
heuristic; perfectly stable/quantized measurements can also trigger it. A changed valid raw sample
can recover that state. GNSS uses epoch progression rather than stationary coordinates.

Bus errors, invalid fields, saturation, unsupported settings, replay, time reversal and stale ingress
clear that source's measurement. Corrupt unknown frames clear all measurements conservatively.
Missing, stale, uncalibrated, temperature-extrapolated and epoch-unaligned observations are unhealthy.
Snapshots run age checks even when no new samples arrive. All outputs remain diagnostic and retain
`physicalFlightEnabled: false`; a `healthy` fixture is not a measured or flight-approved sensor.

## Clock alignment and its limits

Capture, read completion, host receipt and GNSS navigation epoch remain separate. IMU capture is the
board's data-ready observation with a 2 ms estimate for observation delay. Unknown filter/group
delay is separately flagged `timing-unvalidated`, so no bounded IMU measurement age is claimed. Pressure capture is
the forced-conversion trigger with uncertainty through conversion completion. GNSS capture is the
first byte observed on UART; its actual navigation-epoch age is unknown without PPS/TIM-TP alignment.

`sensorAnchorFromHandshake()` requires a healthy nonce-matched DR status inside a <=20 ms round trip.
The anchor uses the round-trip midpoint, half-RTT plus 1.5 ms sample/scheduling uncertainty, and a
200 ppm drift allowance. It expires after five seconds; obtain a fresh qualified handshake and
call `pipeline.reanchor(anchor, receiptMs)`. Refreshes preserve sample age and stuck history for
the same boot, reject clock offset jumps and clear prior measurements on a new boot. Boot changes or local clock reversal invalidate the anchor. These limits
are configured conservative software assumptions requiring board/transport evidence, not clock-sync
measurements. Unsupported queue delay cannot be erased by assigning receipt time to the sample.

Known uncertainty contributes to an upper age bound. For unvalidated IMU timing and GNSS's unknown measurement epoch,
`measurementAgeUpperMs` and `timeUncertaintyUs` are null and `timing-unvalidated` or `measurement-epoch-unaligned` prevents
healthy synchronized use. Receipt transport age still detects a missing stream. PPS/TIM-TP and
measured sensor conversion/group delays remain acceptance work. No estimator receives a fabricated
position/attitude from this layer.

## Simulator replay and physical acceptance

`createSensorReplay(dataset)` runs the same decoder, calibration and health processing on a virtual
monotonic clock. Attach a fresh replay with `createSimulator({ sensorReplay })`. Simulation steps
advance the sensor stream; pause also pauses replay. Kinematic motion remains the existing ideal
simulation. Sensor playback is exposed in snapshots, not silently fused into flight telemetry.
Pose/estimation fusion belongs to issue #4.

Datasets have `version`, `evidence`, `provenance`, one initial `anchor`, `calibrations` and
`records: [{ receivedAtMs, hex }]`. Anchors serialize `bootId` and `boardUs` as decimal strings.
Optional `anchors: [{ receivedAtMs, anchor }]` retain later qualified handshakes, merged by receipt
time before samples at the same time. Refresh at least every five seconds for long captures; missing
refreshes produce unhealthy/rejected samples rather than invented alignment. Up to 4096 samples and
4096 refreshes in a ten-minute capture are allowed, within 1 MiB. Replay can continue beyond EOF,
where independent ages expire normally; it cannot rewind.

The retained dataset covers scripted IMU motion, known BMP280 factory coefficients, GNSS units and
serial delays. Tests add skew, delayed/future samples, boot changes, source stalls, corruption,
calibration/mount faults and dropout. Native register/UBX tests use bus adapters and bounded real
codecs; they do not establish physical capture or timing.

The [software build snapshot](https://github.com/stacksjs/drone/blob/main/docs/sensor-evidence.json) records the local sensor-profile hash and static
footprint. Static stack frames do not establish a measured high-water mark.

To finish #3, retain actual disabled-load captures from all three devices, sensor/mount identities,
stationary and six-orientation calibration, thermal sweeps, noise measurements and dropout/stuck
fault injections. Measure the acquisition/serialization schedule and align GNSS with PPS/TIM-TP.
Issue #2's board timing/watchdog gates also remain open. Do not commit real location logs or secrets.

Primary specifications: [TDK ICM-42688-P](https://invensense.tdk.com/wp-content/uploads/2022/12/DS-000347-ICM-42688-P-v1.7.pdf),
[Bosch BMP280](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmp280-ds001.pdf),
[u-blox M10 NAV-PVT](https://content.u-blox.com/sites/default/files/u-blox-M10-SPG-5.10_InterfaceDescription_UBX-21035062.pdf).
