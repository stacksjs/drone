# Acknowledged external-driver protocols

Issue [#7](https://github.com/stacksjs/drone/issues/7) adds a shared MAVLink 2 transaction engine
behind the existing ArduPilot and PX4 UDP factories. It implements discovery, acknowledged commands,
message-rate requests, named parameter reads/writes, bounded waypoint transfers and resume requests.
Physical telemetry remains receive-only. No HTTP arm, mode or actuator endpoint is introduced.

## Native Stacks tooling

```sh
./buddy drivers:bench --driver ardupilot --drop-first-ack
./buddy drivers:bench --driver px4 --signed --drop-first-ack
bun run runtime:cli
./storage/runtime-build/cli/drone drivers:bench --driver px4 --signed
bun tests/fixtures/drivers/evaluate.ts
```

`drivers:bench` uses native Stacks `defineCommand()` and is shared by Buddy and the compiled CLI.
It creates a scripted loopback UDP peer with the selected firmware identity, performs discovery,
negotiates a requested 5 Hz message interval, reads/writes an integer, uploads/downloads two waypoints
and requests resume at item 1. The optional ACK drop verifies a retry with confirmation 1.
The public signing key is a test vector, never a deployed credential. All sockets/timers close.
The [retained report](https://github.com/stacksjs/drone/blob/main/docs/driver-protocol-evidence.json) identifies this as a protocol peer, not actual
ArduPilot/PX4 firmware, SITL flight, HIL or measured vehicle execution.

## Public driver contract

```ts
import { createPx4Driver } from '../resources/functions/drone/drivers'

const driver = await createPx4Driver({
  kind: 'sitl', listenPort: 14540, sitlPort: 14580,
})
try {
  const capabilities = await driver.protocol.discover()
  await driver.protocol.setMessageRate(32, 5)
  const current = await driver.protocol.readParameter('EXISTING_PARAM')
  // Only after checking the simulator's parameter metadata and intended value:
  await driver.protocol.writeParameter(current.id, current.value, current.type)
  // uploadMission(items), downloadMission(), resumeMission(index)
}
finally { driver.close() }
```

The ArduPilot factory has the same interface. Use only a local simulator endpoint without physical
forwarding. `listenPort: 0` chooses an ephemeral local port, exposed as `localPort`. Target system
and component default to 1/1 and are explicit options. Client identity is 245/191. Loopback IP,
peer port and source identity are pinned. A matching quadcopter firmware heartbeat must precede
transactions even when a destination port was configured. There is no multi-vehicle router.

The engine runs under `resources/functions/drone/drivers/`; it has no dependency on the owned
runtime, authority supervisor or future mission engine. Domain workflows can replace these drivers.
Stacks owns command discovery, packaging, tests and read-only capability reporting. No database
queue or HTTP retry middleware owns this clock-sensitive protocol state.

`protocol.snapshot()` reports negotiated capabilities, source, heartbeat time, active operation,
quarantined transaction keys and terminal faults. It does not transmit or refresh time. It contains
no keys or physical authority. Constructor options are captured; changing `kind` on the caller's
object cannot promote a physical receiver.

## Discovery, commands and timing

Discovery sends `MAV_CMD_REQUEST_MESSAGE` (512) for `AUTOPILOT_VERSION` (148). Both an accepted
`COMMAND_ACK` and a version response are required, in either order. MAVLink 2 capability is required
for the new microservices; legacy v1 telemetry and velocity behavior remain compatible. Mission
transfers require the advertised `MISSION_INT` capability. Changed UID, software version or
capability data invalidates the session. Target discovery selects only the configured system/component
and chosen firmware profile; it does not infer a vehicle from arbitrary packets.

`sendCommand(id, params, { signal })` sends finite, bounded float32 parameters in `COMMAND_LONG`.
This generic API is SITL-only and may affect the local simulator, including if a caller explicitly
chooses an arm/mode command. Command-specific prerequisites and spatial `COMMAND_INT` are not
implemented. Do not interpret generic serialization as vehicle-specific command support.
`setMessageRate(messageId, hz)` uses command 511 and permits 0.1..50 Hz. Its ACK proves acceptance
of the request, not measured delivery rate. A denied/unsupported ACK is a typed rejection.

| Bound | Behavior |
| --- | --- |
| Active operations | One per driver session, no unbounded queue |
| Initial response wait | 500 ms |
| Retries | Three after the initial send; command confirmation increments |
| In-progress ACK | No command retransmission; wait up to 5 s for another update/final ACK |
| Entire operation | 30 s maximum, including mission stages/progress |
| Matching heartbeat | Expires after 1500 ms, before a late heartbeat can revive the session |
| Ambiguous transaction keys | At most 64; then the session terminates |
| Download completion record | One final item or empty COUNT, retained up to 10 s for re-ACK |

The UDP adapter polls every 25 ms and emits a client heartbeat at 1 Hz only after explicit SITL
capability discovery. The pure engine can also be driven by deterministic `tick()` calls in tests.
Clock reversal, link expiry, transport failure and close terminate pending work and require a new
adapter. Node/Bun event-loop timing is not a real-time safety mechanism.

ACKs are matched by source, command and optional recipient fields. Progress never implies completion.
A final accepted ACK returns `executionConfirmed: false`: validate actual mode/mission/vehicle state
separately. MAVLink command ACKs have no request nonce. Operations are serialized; mission duplicates are handled by their transfer stage, and
timeout/cancellation quarantines the affected key, including every command stage
of resume. Repeating an uncertain command requires a fresh connection and reconciliation of remote
state. This does not establish exactly-once execution or eliminate all stale-response ambiguity.

All operations accept `AbortSignal`. An already aborted signal sends nothing. Active cancellation
stops local retries and rejects; mission cancellation sends a best-effort `MISSION_ACK` cancellation.
There is no `COMMAND_CANCEL`/remote cancellation guarantee yet. A remote command or partial write
may already have taken effect, even when the local result is cancelled or timed out.

## Parameters

Capabilities select bytewise or C-cast encoding; contradictory advertised encoding bits are rejected.
When neither bit is advertised, the explicitly selected profile supplies PX4 bytewise or ArduPilot
C-cast encoding and reports `encodingEvidence: 'explicit-driver-profile'`. This compatibility fallback
is visible, not inferred from whichever packet arrives first. Verify it against the actual firmware
version during the outstanding SITL campaign.

IDs are 1..16 printable ASCII characters without spaces, with exact handling of a full 16-byte name.
Reads are by name; no index-based cache or full-table synchronization is claimed. A write first reads
metadata, requires the same type, sends `PARAM_SET`, then explicitly requests/readbacks the value.
This supports ArduPilot implementations that omit a set echo. Old/mismatched values cannot confirm
a write; retries remain bounded. Unrelated parameter broadcasts are ignored by ID.

Supported types are uint8/int8, uint16/int16, uint32/int32 and finite float32. Integer ranges and
float32 overflow are checked; C-cast integers must survive float32 conversion exactly. Bytewise
integers use their actual raw bits, including patterns that would be NaN as floats. Unsupported
64-bit/extended types, non-finite floats, wrong metadata and malformed count/index/ID are refused.
A reported match confirms readback, not persistence across reboot or unchanged external ownership.

## Missions and resume

This first profile transfers mission type 0 with up to 128 `NAV_WAYPOINT` items. Frames 5/6 mean
GLOBAL_INT MSL or GLOBAL_RELATIVE_ALT_INT home-relative altitude; latitude/longitude use 1e7 scaled
integers. These frames are distinct from the owned controller's LOCAL_NED. Latitude, longitude,
altitude and waypoint parameters are bounded; yaw `null` encodes the standard NaN “use current yaw”.
Other NaNs/infinities, local/terrain frames, other commands and non-autocontinue items are unsupported.
This is a transport subset, not an airspace, terrain or mission safety validator.

Upload is COUNT, ordered REQUEST_INT/ITEM_INT, then accepted ACK only after all items were requested.
Repeated prior requests are served without advancing progress. The legacy REQUEST message is answered
with ITEM_INT. Download is REQUEST_LIST, stable bounded COUNT, sequential REQUEST_INT/ITEM_INT and
final ACK. A bounded completion record re-ACKs matching final-item/empty-COUNT retries for up to
10 seconds, including during a following resume request. New uploads/downloads clear it. Ahead-of-order items cannot advance progress; conflicting duplicates/count changes fail.
A zero-item transfer is supported. Uploading an empty list replaces the simulator plan with an empty
plan, so call it deliberately. Cancellation/failed transfer makes remote plan state uncertain.

`resumeMission(index)` requires a successful upload/download in the current session and an in-range
index. It sends command 224 to select the item, waits for both accepted ACK and matching
`MISSION_CURRENT`, then sends command 193 with continue=1 and waits for its ACK. It does not arm,
take off, select an automatic flight mode or prove motion. Unsupported commands fail explicitly;
no silent firmware-specific fallback occurs. External plan edits and autonomous execution must be
reconciled by the future mission engine. Use exclusive plan ownership during a transfer/resume.

## Signing and replay boundaries

Optional `signing: { key, linkId, timestamp }` requires a 32-byte key, byte link ID and callback returning
48-bit 10-microsecond ticks since 2015-01-01 UTC. The key is copied and never included in snapshots.
When configured, both directions use signed MAVLink 2 and unsigned input is refused. Without a
verifier, signed input remains refused, preserving the original behavior.

The verifier checks CRC, SHA-256's six-byte keyed signature and constant-time digest comparison.
Per source-system/component/link timestamps must strictly increase, within a local +/-60 s window.
At most 16 inbound streams are retained. Clock reversal fails closed. Wire sequence wrap does not
reset the signing watermark. Independent pymavlink vectors verify both signing and verification.

Watermarks are in memory. Restart persistence, secure key provisioning/rotation, deployed timestamp
initialization and cross-restart replay campaigns remain open. Unsigned loopback mode is not
source authentication or cryptographic replay protection. Wire sequence numbers alone cannot
supply those guarantees, and a sequence wrap must not discard fresh responses. Never route the conformance peer or its public key to hardware.

## Remaining issue #7 gates

| Sub-capability | Status |
| --- | --- |
| Full ArduPilot and PX4 firmware SITL round trips | Pending pinned-firmware campaigns, actual supported commands, parameter metadata, mission variants and measured rates |
| Physical write capability and HIL | Disabled; requires independent authority, link, hardware and vehicle evidence |
| COMMAND_INT, remote command cancellation and command-specific state checks | Deferred under #7 |
| Serial and TCP, stream framing/reconnect/backpressure | Deferred under #7; only loopback UDP datagrams implemented |
| Signing key lifecycle and persistent replay state | Deferred under #7/#9 |
| Complete mission commands, fence/rally, terrain, opaque IDs, partial transfers and mission ownership | Deferred under #7/#10/#11 |
| Parameter list/EXT, metadata, table change tracking and persistence | Deferred under #7 |
| FTP and log transfer | Deferred under #7/#9 |
| Events, RTC/time synchronization and RTCM corrections | Deferred under #7/#4/#9 |
| Payload and gimbal protocols | Deferred under #7/#8/#26 |
| DDS/ROS 2, CAN/DroneCAN/Cyphal routing/gateways | Deferred under #7/#8 |

Sources: [MAVLink command protocol](https://mavlink.io/en/services/command.html),
[mission protocol](https://mavlink.io/en/services/mission.html),
[parameter protocol and implementation differences](https://mavlink.io/en/services/parameter.html),
[common message definitions](https://mavlink.io/en/messages/common.html) and
[signing specification](https://mavlink.io/en/guide/message_signing.html).
Protocol logic is original TypeScript. The optional development fixture generator uses pymavlink
2.4.50 to retain independent wire vectors; no vendor Python package is a runtime dependency.
