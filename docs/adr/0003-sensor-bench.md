# ADR 3: Typed sensor acquisition beside the neutral runtime

Status: implementation direction for issue #3.

Use an optional Pico 2 sensor-bench profile: ICM-42688-P on SPI0, BMP280 on I2C0 and u-blox
NAV-PVT on receive-only UART1. Keep the original synthetic runtime image and DR v1 authority
protocol available. Every image keeps the test output neutral. There is no sensor-to-actuator path.

The C++17 exception from ADR 2 covers register acquisition and bounded parsing. Original register
adapters use the vendor specifications; no third-party sensor driver is vendored. Calibration,
unit/frame conversion, clock mapping, quality checks and replay stay TypeScript under
`resources/functions/drone/sensors/`. Native Stacks commands own file inspection and replay;
transient replay data needs no model, migration or background queue.

Use a separate DS v1 fixed 128-byte telemetry frame. It carries the boot token, device identity,
sequence, capture/read-completion times, uncertainty, quality bits and raw register values.
The existing bounded UART queue multiplexes DR and DS, with runtime replies taking priority.
IMU registers are sampled on the 1 kHz loop and decimated to at most 50 Hz for the Pi stream;
pressure runs at 10 Hz and NAV-PVT is configured externally for at most 5 Hz. UART capacity and
clock/timing uncertainty must be measured on the actual setup.

Logical sensor IDs identify the profile's bus/type/instance within one boot. They are not unique
silicon serial numbers. Operators must associate measured calibration/mount profiles with their
physical board and sensor assembly. Cross-board automatic calibration identity is future work.

Use BODY_FRD for calibrated IMU vectors: forward, right, down, right-handed. Accelerometer values
are specific force, not gravity-removed acceleration. At rest on a level frame the body Z specific
force is approximately -g. GNSS retains WGS84 geodetic coordinates, separate ellipsoid/MSL heights,
and NED velocity. Pressure stays in Pa; no unqualified altitude conversion is supplied.

Only a bounded, nonce-matched runtime handshake can establish a live clock anchor. Fixture clocks
are labelled explicitly. Keep capture, read-completion, host receipt and navigation epoch distinct.
Without PPS/TIM-TP alignment, NAV-PVT's board timestamp is receipt time and measurement age is
unknown. Mark it unhealthy for synchronized sensor use. Do not hide this behind a fresh packet.

Covariance is explicit diagonal variance: configured sensor-axis noise transformed through scale
and the signed mount permutation, pressure noise variance, and GNSS accuracy-derived estimates.
These are not measured full covariance matrices. Measured sensor noise, mounting, bias and thermal
coefficients remain physical acceptance work. Synthetic fixture coefficients cannot establish
flight readiness. All diagnostic interfaces retain `physicalFlightEnabled: false`.

Issue #2 remains open for board timing/watchdog tests. Issue #3 can advance in software while its
physical acquisition, calibration and time-alignment gates remain open. Neither issue is complete
from cross-compilation, synthetic datasets or host tests.
