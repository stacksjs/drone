# Hardware shopping list

Designed for the owner's **Raspberry Pi 5, 8 GB**, with no accessories yet, outdoor follow development,
and a **US$900-1,400 budget**. Research date: October 17, 2026, America/Los_Angeles.
Country is not confirmed; radio variants and regulatory purchases must match the country of use.
Do not buy a second Pi. These are off-the-shelf hardware parts assembled at home with your own application software.

## Start with the owned-runtime bench

For your own runtime, start with the Pi accessories and AI Camera below, then this separate
Pico 2 bench kit. The firmware currently produces neutral diagnostic outputs. The
[runtime guide](runtime.md) defines its wiring and measurements; add the
[sensor profile](sensors.md) as a later bench stage. No airframe or external autopilot firmware
is needed to begin that work.

Bench prices checked October 20, 2026. These are additional to the airframe table, before tax,
shipping and tools you do not already own. Listed prices come from the linked suppliers;
allowances are estimates. Confirm stock before ordering.

| Qty | Bench part | USD | Purpose |
| --- | --- | --- | --- |
| 1 | [Raspberry Pi Pico 2](https://www.raspberrypi.com/products/raspberry-pi-pico-2/), non-wireless model | $5 listed | Matches the implemented `pico2` firmware target |
| 1 | [Adafruit CP2102N Friend, product 5335](https://www.adafruit.com/product/5335) | $5.95 listed | USB-UART with 3.3 V signals; its 5 V power pin is a separate rail |
| 1 | [SparkFun TOL-18627 logic analyser](https://www.sparkfun.com/usb-logic-analyzer-24mhz-8-channel.html) | $26.95 listed | 8 channels, up to 24 MHz, PulseView support; initial UART and tick/reset pulse inspection |
| 1 set | USB data cables for both boards, headers, jumper leads and 10 kOhm pulldown | $15-25 allowance | Assembly and the neutral test-pin pulldown specified in the runtime guide |

Allow roughly **$55-70** for this basic bench kit. The analyser's supplier warns that the pin
beside input 6 may not be ground; use its documented ground connection. This entry-level analyser
is not evidence of adequate 8 MHz SPI waveform characterization. An oscilloscope, debug probe,
soldering equipment and sensor boards are additional costs if needed. Borrow instruments when
possible to preserve the aircraft budget.

For the later sensor stage, the implemented profile requires an **ICM-42688-P SPI breakout**,
**BMP280 at I2C address 0x76**, and **u-blox M10-class UART NAV-PVT**. Match the exact part,
exposed signals and voltage to the [sensor bench guide](sensors.md). The
[Adafruit BMP280, product 2651](https://www.adafruit.com/product/2651) lists at $9.95.
Use its [pinout guide](https://learn.adafruit.com/adafruit-bmp280-barometric-pressure-plus-temperature-sensor-breakout/pinouts)
for breakout connections. [Bosch's datasheet, section 5.2](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmp280-ds001.pdf#page=28)
specifies SDO tied to ground for address 0x76. BME280 and BMP390 are different chips and are
not accepted by this profile. The
[SparkFun MAX-M10S, GPS-18037](https://www.sparkfun.com/sparkfun-gnss-receiver-breakout-max-m10s-qwiic.html)
lists at $45.95, requires a separate compatible SMA antenna and uses 3.3 V power/signals. Its
[UART defaults](https://docs.sparkfun.com/SparkFun_u-blox_MAX-M10S/hardware_overview/) are 38400 baud;
configure it externally for this profile's 115200 baud and NAV-PVT at 1-5 Hz before use. Its page
shows mixed stock/backorder labels, so availability is unconfirmed. No specific IMU breakout or
complete sensor assembly has been physically qualified here. Keep sensor procurement separate
from the basic bench subtotal and the existing aircraft estimate.

## Recommended base: Holybro X500 v2 development kit

Choose **Pixhawk 6C + M10 GPS**, not the frame-only or ARF option.
The [manufacturer listing](https://holybro.com/products/px4-development-kit-x500-v2) showed **$609**
for that variant when researched. It includes frame, landing gear, four 2216 KV920 motors, four
20 A ESCs, power distribution, power module, GPS and telemetry radios. Avoid buying those parts twice.
This project implements separate ArduPilot and PX4 drivers. Their command paths currently target
local quadcopter SITL; physical telemetry is receive-only and physical flight commands remain disabled.
Choose flight-controller firmware independently of the owned mission and camera logic. No firmware
flash or physical-flight qualification follows from this shopping list.

The separate [owned board runtime](runtime.md) uses a Pico 2 for bench development. Pixhawk 6C flight
firmware, physical control and measured aircraft validation remain separate roadmap work. Keep the
Pi 5 for Stacks mission and camera logic.

Choose a legal telemetry frequency locally. The manufacturer offers 433 and 915 MHz; its regional
labels are a starting point, not permission to use that band in every country. RC control is a separate link.
The kit supports 4S batteries. Manufacturer guidance is **4S 3,000-5,000 mAh, 20C or higher, XT60**.
Do not substitute a 6S pack with these stock ESCs.

## Buy these

Observed prices are marked **listed**. Everything else is a planning allowance, not a current quote.
The links identify the product or specification to shop for.

| Qty | Part | USD allowance | Compatibility and purpose |
| --- | --- | --- | --- |
| 1 | [X500 v2 development kit, Pixhawk 6C/M10](https://holybro.com/products/px4-development-kit-x500-v2) | $609 listed | Full airframe and autopilot bundle above |
| 1 | [Raspberry Pi AI Camera](https://www.raspberrypi.com/products/ai-camera/) | $70 listed | IMX500 on-camera inference; recommended for later visual tracking experiments |
| 1 | [Official camera cable, Standard-Mini, 200 mm](https://www.raspberrypi.com/products/camera-cable/) if not included | $3-6 | 15-pin camera to 22-pin Pi 5 connector; check the camera box first |
| 1 | [Pi 5 Active Cooler](https://www.raspberrypi.com/products/active-cooler/) | $5-8 | Cooling during sustained inference |
| 1 | 64 GB A2 microSD from a reputable seller | $12-20 | Raspberry Pi OS Lite 64-bit and development logs |
| 1 | [Official Pi 27 W USB-C supply](https://www.raspberrypi.com/products/27w-power-supply/) | $12-15 | Bench supply, not an airborne AC supply |
| 1 | [RadioMaster Pocket, ELRS 2.4 GHz, Mode 2](https://radiomasterrc.com/products/pocket-radio-controller-m2) | $71.50 listed | Choose local FCC/LBT variant; avoid the incompatible CC2500 version |
| 2 | Quality flat-top unprotected 18650 cells for the Pocket | $10-16 total | Match RadioMaster's cell specification; cells are often not included |
| 1 | [RadioMaster RP1 V2 ELRS receiver](https://www.radiomasterrc.com/products/rp1-expresslrs-2-4ghz-nano-receiver) | $18.99 listed | CRSF UART receiver; requires proper power, signal wiring, antenna mount and compatible firmware |
| 1-2 | 4S 4,000-5,000 mAh conventional LiPo, >=20C, XT60, JST-XH balance lead | $45-60 each | Start with one; check dimensions, weight and tray fit. Shop reputable Gens Ace/Tattu or equivalent packs by this specification |
| 1 | [ISDT 608AC AC/DC balance charger](https://www.isdt.co/hobby/ac-dc-charger?lang=en) | $65-90 | AC supply included, 4S supported; confirm XT60 charging lead, JST-XH balance connection and local mains cord |
| 1 | [Pololu D24V50F5 5 V/5 A regulator](https://www.pololu.com/product/2851) | $32.95 listed | Dedicated Pi rail from 4S pack; validate temperature, cable drop and actual available current |
| 1 set | Fused Pi power harness, rated connector, switch, 18-20 AWG power wire, heatshrink, insulating mount | $20-35 | Includes proper termination; do not use breadboard jumper wires for Pi power |
| 1 | Short USB-A to Pixhawk USB data cable | $5-10 | Check the exact controller's USB socket; preserve separate power rails and avoid VBUS backfeeding |
| 1 set | Pi/camera mounting plate, M2.5 standoffs, locking hardware, strain relief and straps | $20-35 | Validate cooler clearance, centre of gravity, GPS clearance, and camera view outside the propeller arcs |
| 1 set | Extra matching 1045 CW/CCW props, multimeter, smoke stopper, LiPo storage bag | $35-60 | Kit has some spare props; a soldering iron/crimper adds cost if you do not already own one |

With one battery the airframe table totals roughly **$1,035-1,160**, excluding tax/shipping,
regional compliance gear, the separate runtime bench and additional tools. Including the basic
$55-70 runtime bench allowance gives roughly **$1,090-1,230**, before those exclusions and later
sensor purchases. A second battery adds $45-60. Reserve the rest of the budget for connectors,
tools and Remote ID if required; check the complete cart against your budget before ordering.
Do not order expensive gimbals, RTK receivers or depth cameras for the first build.

## Camera choice

**My first choice: the $70 AI Camera.** Its IMX500 runs compatible neural networks on the camera,
keeping more Pi CPU available for your custom logic. It has manual/mechanical focus and about
78-degree field of view. It is not an autofocus Camera Module 3. Models must be converted for its
accelerator; this repo now implements an acquisition/tracking pipeline, with on-device validation still pending.

**Cheaper alternative: [Camera Module 3 Wide](https://www.raspberrypi.com/products/camera-module-3/),
allow roughly $35-40.** It offers autofocus and a 120-degree diagonal field of view, useful for keeping
nearby subjects in frame, but inference runs elsewhere and the wider view gives fewer pixels on distant
subjects. Get the normal IR-filtered version for daylight, not NoIR. Do not buy both initially.

Neither camera supplies depth, collision avoidance, stable gimbal footage, or reliable target identity.
Visual following requires an explicitly selected subject, tracking across frames, loss handling and an
appropriate position/range source. Keep a paired GPS target as the first outdoor-follow milestone.

## Power is the critical Pi 5 detail

The [Pi documentation](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html)
specifies a quality 5 V supply; full peripheral power needs a suitable 5 A supply. USB-C PD negotiation
matters. A random buck converter plus a USB-C pigtail is not a verified 5 A PD supply.

The Pololu module is a candidate **regulated 5 V GPIO rail**, not a USB-C PD adapter. If using that
route, use correctly fused, protected, rated wiring to the Pi's documented 5 V/GND inputs and have
someone comfortable with power electronics inspect it. It bypasses USB-C negotiation and some input
protection. Do not simultaneously attach the bench supply. Test under full camera/CPU load for brownouts
and thermal derating. A nominal 5 A rating is not proof of 5 A at the board in flight.
For USB-C instead, buy an explicitly Pi 5-compatible vehicle supply with the right PD profile and rerun
those tests. Never feed raw 4S voltage into the Pi, or draw Pi power from a Pixhawk telemetry port.

## Regional items

If flying in the US, budget for a **broadcast Remote ID module with a current FAA-accepted declaration**
unless the flight qualifies for an applicable exception. Check the [FAA database](https://uasdoc.faa.gov/)
for the exact model and serial format before buying. A $20 developer board is not automatically an
approved DIY retrofit: [Holybro explicitly warns](https://holybro.com/products/remote-id) that its
Standard Remote ID product requires the integrator's own approval process.

The [Holy Stone HSRID02 listing](https://store.holystone.com/products/hsrid02) showed $42.99 but also
reported sold-out status during research. Treat it as a candidate only after checking its exact current
FAA declaration, stock and serial requirements. Allow **$50-150** for an available accepted module.
Do not confuse the older HSRID01 declaration with approval for HSRID02.

US recreational flight also involves registration for this weight class, TRUST, visual line of sight,
authorized airspace and the applicable altitude rules. Follow-me does not remove pilot duties.
Commercial/non-recreational work can require Part 107. See the [FAA recreational guidance](https://www.faa.gov/uas/recreational_flyers)
and [Remote ID guidance](https://www.faa.gov/uas/getting_started/remote_id). Outside the US use the local aviation authority.

## Buying order

1. Pi bench accessories and camera, then the Pico 2 bench kit for the owned runtime. Run the simulator and camera examples; collect the separate runtime measurements before adding sensors.
2. RC transmitter and receiver when preparing the airframe.
3. Full kit, one 4S battery and charger, then assemble with props removed.
4. Dedicated Pi power and mounting after bench current and weight measurements.
5. Regional compliance gear before outdoor flights; a second battery once the build works.

Manufacturer hover-time figures do not predict endurance with your Pi, camera, regulator and battery.
Measure the complete aircraft mass and thrust margin, then obtain endurance from cautious validation.
