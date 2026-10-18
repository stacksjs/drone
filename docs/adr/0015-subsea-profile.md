# ADR 0015: Owned pressure/DVL subsea inspection profile

Status: accepted for modeled software, physical outputs inhibited.

## Decision

Add `subsea` to the explicit version 2 vehicle contract. A session owns its plant,
controller, pressure/DVL navigation, sensor sequence and inspection payload port.
Use the shared mission engine, authority supervisor, independent output watchdog,
recording and native Stacks CLI/workspace entrypoints. Do not create a separate
underwater mission implementation or require ArduSub.

Raw owned IMU tilt and delayed pressure/DVL measurements estimate a local
water-surface-relative NED state. GNSS is absent underwater. The six-axis plant
uses eight signed idealized thruster forces with full-rank wrench allocation,
water-relative drag, buoyancy, restoring torque and modeled tether force. Neither
controllers nor payload logic receive truth state.

Inspection capture waits for post-request camera/sonar data while exact pending
scope and autonomous authority remain valid. An uncertain event is consumed and
requires operator assessment before a differently scoped mission. Export binds
ACK, recorded measurements and capture pose and retains synthetic P5 bytes,
ranges, provenance and explicit uncertainty assumptions.

## Consequences

This provides a connected simulation and inspectable software contract for ROV
work. It does not establish a physical transport, sensor driver, thruster curve,
absolute underwater position, authenticated evidence, imaging sonar, inspection
coverage, qualified survey or reliable passive recovery. The fixture origin,
initial north alignment and local surface pressure are declared assumptions.

Tether, leak, depth, DVL/pressure quality, emergency, host, IMU, sensor, operator
and kill losses inhibit outputs. A neutral board cannot guarantee vehicle safety
around entanglement or overhead structures. Hardware evidence remains a separate
acceptance gate described in [the profile guide](../vehicles-subsea.md).
