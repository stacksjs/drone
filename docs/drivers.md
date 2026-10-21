# Replaceable autopilot drivers

The destination is an owned vehicle autonomy stack. ArduPilot and PX4 are optional external firmware
drivers, not mandatory dependencies of the simulator, camera tracker or future mission engine.
The driver implementation here is a small common-MAVLink subset, not full firmware feature exposure.

| Contract | ArduPilot driver | PX4 driver | Owned native stack |
| --- | --- | --- | --- |
| Factory | `createArduPilotDriver` | `createPx4Driver` | Planned |
| Heartbeat identification | ArduPilot 3, quadcopter 2 | PX4 12, quadcopter 2 | Planned versioned handshake |
| External mode normalization | Guided becomes `guided` | Offboard becomes `guided` | Planned authority state machine |
| Hardware commands | Disabled, receive-only | Disabled, receive-only | Not implemented |
| Local simulator commands | LOCAL_NED velocity-only | LOCAL_NED velocity-only after priming | Existing ideal kinematic simulator |
| Generic COMMAND_LONG | SITL-only acknowledged requests, execution unvalidated | Same | Separate native authority |
| Missions/parameters/ACK/signing | Shared bounded transaction subset, optional strict signing, firmware SITL pending | Same, bytewise parameter profile | Separate mission/runtime contracts |

Import factories from `resources/functions/drone/drivers/index.ts` on the server. The older
`createUdpAdapter()` remains compatible and defaults to the ArduPilot profile. Driver choice and
transport mode are captured at construction and cannot be promoted by mutating caller options.
They reject the other firmware's heartbeat and currently support only the quadcopter vehicle type.

PX4 `custom_mode` stores main mode in bits 16-23 and submode in bits 24-31. Main 6 is Offboard;
Auto submodes 5/6 are Return/Land. These are distinct from ArduCopter's mode numbers.
The existing generic `guided` field means external-velocity authority, not a PX4 mode name.

## Acknowledged protocol services

The new `driver.protocol` interface adds capability discovery, COMMAND_ACK/retries, message-rate
requests, parameter read/write with readback and bounded mission upload/download/resume.
Read the [protocol contract, native conformance CLI and limits](https://github.com/stacksjs/drone/blob/main/docs/driver-protocols.md).
Only scripted loopback conformance has been executed; real firmware SITL and physical validation
remain open. Physical receivers cannot transmit through any of these methods.

## PX4 Offboard entry

PX4 requires a continuing proof-of-life setpoint stream before entering Offboard. The new
`primeOffboard()` is explicit, PX4-SITL-only and transmits one zero-velocity setpoint per call.
Call at 5 Hz. This implementation requires 1.5 seconds of priming and resets readiness after a
400 ms gap. Fresh heartbeat/position/battery data, finite local estimates and battery reserve are
required. It refuses priming in Return/Land. It never arms or changes modes.

After priming, the simulated pilot must select Offboard explicitly. Continue sending at 5 Hz; the
adapter refuses the velocity stream if it was not primed or has a timing gap. Release stops the
stream and PX4's configured Offboard-loss behavior owns the response. Test `COM_OF_LOSS_T` and the
configured fallback independently. There is no claim that stopping the stream instantly stops a vehicle.

```sh
bun run sitl:px4 --enable-sitl
```

Use only with a local PX4 quadcopter simulator forwarding MAVLink to `127.0.0.1:14540`, with no
physical forwarding. The runner has a 30-second cap, a synthetic target 20 m north of EKF origin,
and no arm/mode commands. Configure sufficient telemetry rates and take off to 12 m through the
simulator's own ground station. This release has local UDP tests, not a completed PX4 SITL flight.

Follow the [PX4 simulation guide](https://docs.px4.io/main/en/simulation/) for the selected version.
A fixed-wing or rover cannot inherit this quadcopter velocity contract merely because it speaks
MAVLink. Those vehicle-specific drivers and controller semantics are separate roadmap work.

References: [Offboard contracts](https://docs.px4.io/main/en/flight_modes/offboard),
[pinned PX4 mode definitions](https://github.com/PX4/PX4-Autopilot/blob/ddcaad6601be20453ec6acd0f08e567af3a7e1bb/src/modules/commander/px4_custom_mode.h),
[ArduCopter Guided commands](https://ardupilot.org/dev/docs/copter-commands-in-guided-mode.html).
