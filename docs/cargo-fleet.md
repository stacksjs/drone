# Two-carrier modeled cargo handover

`simulateCargoFleet()` in `resources/functions/drone/cargo/fleet.ts` runs two actual
retained vehicle sessions on the same 4 ms clock. One source point parcel falls onto
a station, follows a finite powered rail, enters an initially empty receiving body,
and then flies the receiver's own delivery and return route.

This is a bounded fictional simulation, with physical outputs inhibited. It does not
qualify an aircraft, station, recipient identity, electrical endurance or BVLOS service.
The [single-carrier guide](cargo-delivery.md) retains the wider operations evidence case.

## Native command and exit status

```sh
./buddy cargo:fleet
./buddy cargo:fleet --scenario receiver-primary-link-loss
./buddy cargo:fleet --scenario receiver-both-links-loss
./buddy cargo:fleet --scenario receiver-host-loss-before-intake
./buddy cargo:fleet --scenario intake-receipt-loss
./buddy cargo:fleet --scenario receiver-joint-shift-before-intake
```

The command emits one JSON line, at most 16 KiB. Exit 0 means the modeled routes and
captured custody completed. Exit 2 retains an incomplete modeled outcome. Exit 1 means
invalid input, execution or output failure. The standalone `drone cargo:fleet` command
uses the same native Stacks definition. `cargoFleetSummary(run)` projects observed
results without serializing the full runtime journals.

The library accepts only an optional own-data `scenario` declaration from this finite
set. It does not yet accept arbitrary fleet geometry, vehicle count or hardware transports.

## One world, two authority owners

Carrier A uses raw boot 101 and authority session 201. Carrier B uses raw boot 102 and
session 202. Both use the fixed synthetic WGS84 origin 0, 0, 100 and LOCAL_NED, with down
positive. These are distinct model identities, not authenticated identities or distributed
clock qualification. Each retains its own raw IMU/GNSS pipeline, estimator, mission,
controller, output watchdog and primary/backup radio observer.

A begins at [0, 0, -0.1] m with a 0.1 kg body-forward point at 0.08 m. B begins at
[3, 2, -0.1] m with a declared empty joint. The first site is [3, 0, 0] m and the final
recipient site is [6, 2, 0] m, each with a 0.35 m horizontal acceptance disc. Both bodies
use the declared flat -0.1 m ground datum; the parcel capture plane is down 0. No landing
gear, collision/contact geometry, wind/weather envelope or surveyed field is inferred.

The receiving task holds its declared pad with neutral motor commands from its first
frame. It does not preload mass. Flight policy consumes the owned estimator and modeled
sensor captures. Physical joint geometry is used only inside the modeled mechanism's
contact operation; it is not supplied as a flight-controller positioning oracle.

## Transfer and custody

1. A's existing release coordinator requires current observed site/recipient/load evidence
   and its own mission scope. The world checks actual same-epoch host availability,
   supervisor boot/session, current lease, recent policy and pending command before separation.
2. The actual separation event supplies the point to the [station actor](cargo-station.md).
   Free fall retains the within-step impact epoch, impulse and mechanical loss. Only after
   A confirms station custody does the rail start toward B's declared current joint.
3. B's intake coordinator requires 26 distinct qualified captures spanning at least 500 ms,
   its boot/reference, healthy estimator/gyro, conservative pad uncertainty, contact, stopped
   motors, a clear site and the captured ready-station parcel/source event. It issues one
   modeled grant, valid for at most 40 ms and within the pending task deadline.
4. On a later 4 ms epoch the mechanism independently checks B's actual host availability,
   current supervisor boot/session/lease, recent policy, exact pending command and neutral
   outputs. It consumes the station's departure once and calls actual `attachParcel` at
   B's current joint. A refused point enters the world's separate loose-parcel actor and continues
   ballistic motion to the declared capture plane. It is not copied back, repositioned
   onto the joint or silently retried.
5. A later B sensor capture must report that actual intake event, source event, mass and
   mechanism epoch. Its capture pose and command scope produce the receipt ACK. Requesting
   or granting intake is not confirmation. Only then does B take off with changed mass/CG,
   release the point at the final site and complete captured recipient custody and landing.

The grant's session declaration alone cannot establish authority. The physical-world
check uses the live retained runtime at the actual operation epoch. Host loss can leave
an old supervisor snapshot saying `autonomous`; it still blocks the intake mechanism.

Physical ownership and captured custody are separate records. The world mass ledger reads
the actual body/actor masses after transitions and at 20 ms intervals. It retains one
0.1 kg point and 3.1 kg total mass, with reported maximum numerical error. Historical
separation/departure records are evidence copies, not additional physical owners. The
station reports mechanical work; each vehicle's reserve remains the shared longest-path
**declared power budget**, not measured Wh or an electrical model.

## Bounded model cases

| Scenario | Expected result | Parcel and authority outcome |
| --- | --- | --- |
| `nominal` | Completed | A to station to B to final parcel, with three separate captured custody stages |
| `receiver-primary-link-loss` | Completed | Receiver primary stops during station handling; its independently captured backup preserves authority |
| `receiver-both-links-loss` | Incomplete | Receiver link freshness expires and authority fails; finite station braking retains the parcel while A continues |
| `receiver-host-loss-before-intake` | Incomplete | Host stops 4 ms after the actual grant; no physical intake, independent board expiry and station retention |
| `receiver-joint-shift-before-intake` | Incomplete | A 0.4 N force for one 4 ms step shifts the actual joint before intake; strict coincidence refuses it, the loose point falls, and B lands its counted alternate empty |
| `intake-receipt-loss` | Incomplete | Actual intake occurs but its receipt fields are withheld; B retains the mass and lands its counted alternate without claiming custody or making a second delivery |

Radio observations retain capture, receipt, sequence and scope, with 1 ms clock uncertainty
and 20/40 ms primary/backup delays. Failure stops new packets rather than restamping a
connected fixture. Link loss takes effect through the declared freshness contract.
Vehicle host termination retains a 1,000 ms independent board/plant tail. The other peer
continues its own mission. Both routes and their failure alternatives count toward the
native finite graph/reserve budget; the world is bounded by the 180 s host limit and tails.

## Evidence and remaining work

`tests/unit/cargo-fleet.test.ts` exercises actual two-session physics, intake mass changes,
source/receiver scopes, same-epoch admission, captured receipt ordering, retained mass,
backup continuation, both-link braking, the host/grant gap and uncertain loaded diversion.
`tests/unit/cargo-fleet-cli.test.ts` executes the native Buddy command and its bounded wire.
`scripts/qualify-cargo-fleet-cli.ts` exercises all six cases through a copied standalone
binary outside the checkout and retains output hashes and factual outcomes.

These cases do not cover a complete fleet fault envelope. Receiver/source kill or manual
intervention at every phase, navigation degradation and containment across the transfer,
late/foreign/replayed receipt campaigns, explicit operator cancellation/recovery, durable
whole-world checkpoints, general rendezvous, collision avoidance and richer fleet planning
remain open under [#25](https://github.com/stacksjs/drone/issues/25) and its dependencies.
The wider measured hardware, endurance and operational evidence requirements remain open.
