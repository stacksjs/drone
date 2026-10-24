# Modeled cargo station handling

`createCargoStationHandler` in `resources/functions/drone/cargo/station.ts` owns one
existing point-parcel record through free fall, surface capture, a finite powered rail
and one departure. This is a software simulation prerequisite for
[distinct-vehicle cargo handover](cargo-delivery.md#remaining-issue-scope).
Physical outputs remain disabled.

## Use an actual parcel

Pass the parcel produced by a carrier's actual `separateCarriedLoad()` event, adding
its declared id. An empty receiving body's `intakePoint()` supplies a possible rail
endpoint; it does not supply a parcel. The world coordinator must remove the previous
owner when it creates the station and consume the departure exactly once. Independent
station instances cannot detect a caller cloning a parcel into multiple worlds.

```ts
import { createCargoStationHandler } from '../resources/functions/drone/cargo/station'

const station = createCargoStationHandler({
  atMs: 4,
  parcel: { id: 'parcel-a', massKg: 0.1, positionM: [0.08, 0, -1], velocityMps: [0, 0, 0] },
  pickup: { centerM: [0.08, 0, 0], radiusM: 0.1 },
  destinationM: [1.08, 0, 0],
  maxSpeedMps: 0.5,
  maxAccelerationMps2: 1,
})
```

The literal parcel above is an isolated numerical example. The integration test uses
real source separation and real receiving dynamics rather than manufacturing a parcel
from the receiving joint. All positions, velocities and forces use fixed-origin LOCAL_NED:
metres, metres per second and newtons, with down positive. Mass is kilograms and time
is one modeled local clock in milliseconds.

## Lifecycle and clock

The constructor captures strict own-data records and dense finite three-element arrays.
Unknown fields, accessors and invalid declarations throw `cargo-station-constructor`.
Later caller mutation cannot alter retained state. Bounds are:

- Safe nonnegative initial epoch aligned to 4 ms, leaving 180,000 ms of safe clock range.
- Parcel id matching `[a-z][a-z0-9-]{0,39}`, mass greater than zero and at most 0.25 kg.
- Declared coordinates within +/-1,000 m; initial velocity components within +/-5 m/s.
- Horizontal pickup radius 0.05 to 2 m. The infinite rough capture plane has down in [-1, 0] m;
  the parcel starts on that plane or up to 3 m above it.
- Destination on or up to 1 m above the plane. Center-to-destination distance plus pickup
  radius is at most 20 m, with worst declared rail duration at most 120,000 ms.
- Spatial speed 0.05 to 1 m/s and acceleration 0.05 to 2 m/s².

Call `step(previousAtMs + 4)` to advance the actor. Repeated, skipped, backward, fractional
or exhausted epochs throw `cargo-station-clock` before mutation. The lifetime is at most
180,000 ms from construction; the owning world must bound its run accordingly.

Free fall uses exact constant-gravity kinematics and a quadratic within-step contact time.
The ideal rough plane stops all velocity components. The retained impact contains its
fractional contact epoch, actual point, incoming velocity, impulse and kinetic loss.
The snapshot epoch is the enclosing 4 ms step endpoint. No force peak or impact duration
is invented. A point outside the declared horizontal disc becomes `missed` at its actual
contact location and cannot start transport.

`start()` accepts only `held`, with enough lifetime for the full rail path. It never
retries, moves a missed point onto the rail or starts during free fall. Rail motion uses
a rest-to-rest quintic position law with derived duration respecting both declared spatial
limits. The parcel follows the whole path; its final analytic endpoint is the declared
position with zero velocity. A zero-length route still has a finite 504 ms duration.

`cancel()` is one-way. A moving parcel enters `braking`, with constant deceleration at
the declared acceleration limit until it stops at the physically integrated location.
A falling parcel continues under gravity until plane contact. These requests return
`cancelling`; `cancelled` means it was already at rest. Snapshots distinguish the request
epoch, current phase and fractional stop epoch. Cancellation retains the parcel and
prevents transfer; it does not restore an aircraft's authority or land a vehicle.

`resume()` accepts only a fully stopped cancelled parcel. It starts a fresh bounded
quintic rail from the retained position, preserving mechanical work and the original
180 s lifetime. A missed pickup cannot be resumed into a successful pickup. Snapshots
retain the previous start, cancellation and stop epochs plus the new position/duration.
The detached history contains at most eight resumptions. Further requests are refused;
this primitive does not itself restore vehicle authority or reconcile uncertain custody.

`takeReadyParcel()` accepts only `ready`, returns a detached parcel and clears the
station's owned mass. Further departure attempts are refused. The receiving body's
`attachParcel()` still independently checks its actual current joint. A stale destination
can therefore fail intake; the world must retain the departed parcel and an uncertain
outcome rather than moving or duplicating it to make receipt succeed.

## Mechanical accounting

Snapshots retain current and departed mass/energy, rail force, impact loss and work.
Mechanical energy is `0.5 * mass * speed² - mass * gravity * down`. Free fall conserves
that quantity to binary64 accumulation tolerance. Surface capture dissipates the incoming
kinetic energy. Rail force includes gravity support; lifting increases potential energy.
`stationNetWorkJ` accumulates the represented mechanical-energy change during rail motion
and braking. Positive and negative work fields sum positive and signed negative **sampled
energy increments**, not a continuous actuator-efficiency or power integration.

The residual is `current + departed + planeDissipation - initial - stationNetWork`.
It exposes numerical accumulation instead of substituting a declared battery budget.
This model has no motor, gearbox, battery, measured efficiency, station recoil, parcel
spin, deformation or physical mechanism qualification.

## Evidence and remaining integration

`tests/unit/cargo-station.test.ts` exercises actual source/station/receiver mass transfer,
finite displacement, a worked midpoint, ballistic contact time/impulse/energy, pickup miss,
cancellation during rising flight and powered motion, spatial speed/acceleration bounds,
vertical work, strict admission, detached state and lifetime rejection.

This actor does not grant a mechanism lease, authenticate a recipient, produce a custody
ACK or coordinate two live vehicle mission engines. Those operations must use each
vehicle's own sensor, estimator and current authority scope on the common clock. The
[receiving mission task](cargo-delivery.md#receiving-mission-task-prerequisite) now holds
a declared pad under the shared engine. The [two-carrier world and CLI](cargo-fleet.md) now connect physical intake, current
authority and captured acknowledgement for eleven bounded fault cases and explicit
transport cancellation/recovery. A complete cancellation,
fault/recovery and general fleet matrix remains open under [#25](https://github.com/stacksjs/drone/issues/25).
