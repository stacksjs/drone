# ADR 7: Shared bounded MAVLink microservices behind explicit drivers

Status: accepted first software slice of issue #7. Full firmware SITL and physical acceptance remain open.

Keep the existing ArduPilot/PX4 factories and add a shared `protocol` interface under
`resources/functions/drone/drivers/`. Heartbeat/target identity and capability discovery precede
all new transactions. Keep v1 telemetry/velocity compatibility, while using MAVLink 2 for new
microservices and optional strict signing. Physical mode remains receive-only for every API.

Serialize commands, named parameter operations and bounded mission transfers. Use finite retry,
progress, link and total-operation deadlines, explicit AbortSignal cancellation and quarantined
uncertain outcomes. Distinguish accepted protocol requests from observed execution. Respect
PX4 bytewise and ArduPilot C-cast parameter encodings, including visible profile fallbacks.

Provide a native Stacks `drivers:bench` command with scripted real loopback UDP peers. Verify wire
format and signatures against independent pymavlink fixtures. Identify that evidence honestly;
a scripted peer does not establish that a pinned autopilot firmware implements every operation.
Do not add a database transaction queue, HTTP arm endpoint or dependency on an external autopilot
to our own runtime or mission engine.

Keep serial/TCP, command-specific behavior, complete mission/parameter variants, key lifecycle,
FTP/log/event/time/RTCM services and payload/ROS/CAN gateways as explicit remaining sub-capabilities.
See [the driver contract and limits](../driver-protocols.md) and
[retained conformance evidence](../driver-protocol-evidence.json).
