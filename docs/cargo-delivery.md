# Modeled cargo delivery

The owned quadcopter runtime can execute a delivery mission with a carried point mass,
captured release observations, receiver confirmation, a finite alternate landing and two
modeled communication sources. The raw IMU/GNSS feed, estimator, controls, authority and
independent output watchdog are the same paths used by the other owned vehicle profiles.
ArduPilot and PX4 are optional drivers and are not used by this simulation.

This is software simulation. Physical outputs remain inhibited and identity is not
authenticated. A modeled receiver receipt does not establish a real recipient, hardware
release, package condition, safe aircraft operation or authorization for BVLOS transport.

## Run a declared mission

```sh
./buddy cargo:mission examples/cargo-delivery.json
./buddy cargo:mission examples/cargo-delivery.json --scenario site-blocked
./buddy cargo:mission examples/cargo-delivery.json --scenario after-release-host-loss
```

The standalone `drone cargo:mission` command has the same arguments. The request file is
required. It contains a complete `CargoDeliveryConfiguration`, as shown in the repository's
[fictional example](https://github.com/stacksjs/drone/blob/main/examples/cargo-delivery.json).
There is no inferred destination, parcel, alternate, power declaration or farm location.

| Field | Declaration |
|---|---|
| `version`, `id` | Version `1` and an ASCII mission identifier, at most 40 characters |
| `delivery.origin` | The synthetic feed's fixed WGS84 origin: latitude/longitude `0,0`, ellipsoid height `100` m |
| `delivery.site` | Explicit site, recipient and container identifiers, `positionM` and capture radius |
| `delivery.releaseHeightM` | Height above the receiver plane, from 0.3 to 3 m |
| `load` | Point mass greater than zero and at most 0.25 kg; body-forward offset from -0.1 to 0.1 m |
| `alternateM` | An explicit LOCAL_NED landing point on the modeled zero-down ground plane |
| `power` | `availableWh`, conservative `maxW` and `reservePercent` |

Down is positive. The receiver and alternate down coordinate must be zero. The carrier
starts and returns at the local origin. Its modeled structural datum rests 0.1 m above
the ground; qualified contact, rather than an invented exact zero position, completes
landing. Sites and routes must fit the existing 12 m horizontal and -5 to 0 m down fence.
This flat local world does not implement real terrain, arbitrary geodetic origins or
long-range navigation.

Site radius is 0.1 to 2 m. Site and recipient identifiers use lowercase ASCII letters,
digits and hyphens, beginning with a letter, at most 64 characters; the container is
limited to 40 characters by the carried-body model. Records reject extra fields,
accessors and missing values. Tuples require three finite own data elements.

The complete owned mission validator checks normal and alternate graph duration and
reserve before a plant is allocated. The graph includes takeoff, destination, one
material-drop request, return/landing, and a one-way alternate approach/landing after
payload failure. No failure path retries release. Its fixed task deadlines give a worst
case of 81,520 ms. The declared power ceiling must be at least 600 W; native mission
capacity, reserve and power ceilings still apply.

The example's 150 g parcel is 0.04 m aft of the structural datum. Its destination is
`[2, 1, 0]`, release height 1.2 m, alternate `[-1, 1, 0]`, and budget 50 Wh/700 W/35%
reserve. These are modeled declarations, not a recommended physical aircraft load.

## Outcomes and command delivery

`cargo:mission` returns one compact JSON document, at most 16,384 UTF8 bytes including
its final LF. It retains the admitted configuration, actual outcome, load, parcel,
custody, link events, reserve budget and final board/authority observations.

- Exit 0 requires a matched scenario, received custody and actual modeled carrier
  landing completion with neutral outputs.
- Exit 2 retains a modeled diversion, blocked/incomplete mission, host loss or an
  unmatched scenario. Received custody can coexist with a later carrier failure.
- Exit 1 covers invalid input, rejected admission, unavailable results and output
  failures. The handler attempts one fixed diagnostic without caller data.

The request is a regular file bounded to 16,384 bytes, decoded with strict UTF8. A final
symlink is refused; parent paths are followed. Reading is not path authorization or an
atomic snapshot of concurrent file mutation. Accept results only after both streams
reach EOF and the actual exit status is known. A failed output write can leave a prefix.
JSON parsing uses native last-key-wins semantics. The CLI does not persist a full runtime
journal, canonical signed request or authenticated output.

The existing `cargo:deliver --scenario <name>` command remains a set of closed
demonstrations with its original 100 g forward load. It exits 0 for matched fault
demonstrations as well as the matched nominal route; it does not mean a parcel was
delivered. Invalid input, unmatched demonstrations and output failures exit 1.
The separate [load bench](cargo-load.md) retains its original characterization contract.

## Release and custody

The shared payload port observes qualified delayed measurements, not current plant
truth. Release requires current authority, matching site/recipient evidence, attached
load, stable geometry and 26 distinct fresh captures. Both received observations and
source captures must span at least 500 ms. Retained packets, retiming, clock/reference
changes, stale gyros or scheduler gaps break readiness. Attitude, position, covariance,
issue-time position, task, reference and bounded command lifetime are checked.

The mechanism is dispatched at most once. Command intent, captured open/jammed state,
receiver confirmation and carrier completion remain different observations. A policy
refusal cannot become received custody through ambient receipt fields. Dispatch failure
remains uncertain; uncertain/rejected terminal acknowledgements cancel the scoped
operation before clearing it. Authority loss and close also cancel it idempotently.

The model separates the actual point mass without resetting the carrier's motion,
estimator or controller. The parcel follows a ballistic point trajectory to a plane.
A receiver within the declared radius produces a fictional delayed receipt, which is
then captured and transported. This model has no parcel drag, wind drift, deformation,
collision scene, receiver authentication or measured release mechanism.

## Links and failures

`createRedundantVehicleLinks` selects primary then backup for one captured vehicle,
boot and session scope. It rejects foreign scope, replay, stale/future captures and
invalid clock uncertainty. Age includes uncertainty and preserves the original capture
epoch. Loss of both sources latches, including across an unobserved gap. A late packet
does not silently restore authority. Labels are correlations, not authentication.
The cargo fixture remains one carrier with boot 55/session 123; failover between its
links is not fleet handover.

Named cases include recipient absence, site blockage, mechanism jam, receipt loss,
foreign receipt, primary/both-link loss, independent containment and faults during
the alternate. Position, IMU, vehicle-sensor, RC, kill and host-loss cases also remain.
The command's help lists every exact name.

`after-release-` cases cover host, position, IMU, vehicle-sensor, RC, kill and both-link
loss. `after-receipt-` cases cover host, kill and position loss. Injection starts 20 ms
after the policy first observes the matching mechanism-open or received-custody state,
rather than at a guessed mission time. `faultInjection` retains the observation, source capture, event, actual
trigger and final physical epochs. An unreached anchor stays null and unmatched.

These phase cases add a 1,000 ms independent settling probe after host execution ends.
Only the board and physical plant continue; sensors, estimator, mission, payload and
authority do not run. A parcel can reach the receiver in that interval while custody
stays uncertain because no host received its receipt. A prior confirmed receipt remains
received if the carrier later fails. Ground contact in a settling probe is not controlled
carrier landing. After host loss the reported authority is its last stale snapshot,
while the independent board expires its output lease.

## Library interface and energy limits

Import `planCargoDelivery` from `resources/functions/drone/cargo/plan.ts`,
`simulateCargoDelivery` and `cargoDeliverySummary` from `cargo/delivery.ts`, and
`createCargoDeliveryCoordinator` from `cargo/coordinator.ts` under the same drone folder.
The simulator accepts `{ configuration, scenario? }`; omitting configuration selects
only the named demonstration fixture. The planner requires a complete declaration.
The coordinator implements the existing `VehiclePayloadPort` over an explicitly modeled,
synchronous mechanism adapter and returns detached custody/readiness snapshots.
Full simulation results retain the complete runtime path and replayable mission trace.

Energy is the existing declared maximum-power budget, including the worst normal or
alternate graph and reserve. It is not a motor/battery electrical model, measured Wh,
temperature limit, voltage-sag prediction or Pi performance result. Changing mass changes
the actual modeled dynamics; it does not identify an electrical load law. A successful
budget is conditional on that ceiling and is not measured endurance qualification.

## BVLOS operations evidence

Country and intended operation must be established separately from library support.
Sources below were checked October 24, 2026; inspect their current requirements for the
actual operation. This software issues no authorization.

The FAA's [Part 107 waiver guidance](https://www.faa.gov/uas/commercial_operators/part_107_waivers)
identifies BVLOS and multiple-aircraft operation as distinct waiver subjects. Its
[package-delivery guidance](https://www.faa.gov/uas/advanced_operations/package_delivery_drone)
describes Part 135 certification, airspace authorization and applicable exemption/waiver
work for BVLOS package delivery, with operating-area, communication and collision-avoidance
evidence. A source-code license or simulated receipt supplies none of those approvals.

EASA's [specific-category guidance](https://www.easa.europa.eu/en/the-agency/faqs/operational-authorisation-requirements-specific-category)
distinguishes applicable standard-scenario declarations from national-authority operational
authorizations supported by risk assessment, including SORA/PDRA paths and separate LUC
privileges. A declaration route has its own aircraft and operational conditions.

Before any proposed long-range operation, the operator's evidence case must bind the actual
aircraft, crew, route, containment/alternate volumes, ground risks and authority approvals.
It must address qualified detect-and-avoid and non-cooperative traffic, communication and
navigation coverage/latency/loss, measured endurance and weather, release hardware and
recipient/site procedures, fleet responsibility transfer, emergency response, maintenance
and retained actual logs. These are pending engineering/operations deliverables here.
Two modeled links, selected-person camera tracking and a range obstacle simulation do not
establish an airspace detect-and-avoid system.

## Remaining issue scope

[#25](https://github.com/stacksjs/drone/issues/25) remains open for actual distinct-vehicle
fleet handover, richer endurance models/measurements, durable cargo/runtime reconciliation,
physical release/recipient validation and the separate operational evidence case.
The original acceptance scope is not reduced to passing named demonstrations.
