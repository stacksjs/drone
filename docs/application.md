# Owned prescribed application

Issue #22 adds an inert-water sprayer and inert-granule spreader to the owned ground runtime.
The public functions live in `resources/functions/drone/application/`. Native Stacks commands and
the stx `/application` workspace use the same planning, simulation, replay and coverage functions.
ArduPilot and PX4 are optional drivers and are not imported into this policy.

```sh
./buddy application:plan examples/application-sprayer.json
./buddy application:simulate
./buddy application:simulate --implement sprayer --mode apply --authorize-implement --output /tmp/new-sprayer-visit
./buddy application:simulate --implement spreader --mode apply --authorize-implement --output /tmp/new-spreader-visit
./buddy application:process /tmp/new-sprayer-visit/recording.json --output /tmp/new-reprocessed-visit
./buddy application:replay /tmp/new-sprayer-visit/recording.json
./buddy application:simulate --mode apply --authorize-implement --scenario host-loss
./buddy application:simulate --mode apply --authorize-implement --scenario master-stuck
```

An explicit `--config` replaces the implement preset. `--seconds` accepts 2..180 integer virtual
seconds. Ending before the required mission or fault demonstration returns an unsuccessful exit
status. The default is a dry test with no implement grant. Selecting apply mode alone or granting
authority while remaining in test mode emits no material. Every run remains physically inhibited.
The compiled standalone CLI exposes the same commands outside the checkout.

## Planning and calibration

Configuration v1 declares a fixed LOCAL_NED origin at 0,0,100 WGS84 ellipsoid metres. Ground down
is zero. Polygon coordinates are `[north, east]` metres. Simple concave fields, exclusions and
prescription zones are supported through exact triangulation and clipping; self-intersections,
degenerate edges and overlapping exclusion or prescription interiors are rejected. Unprescribed
support is retained. Exclusions need not cover the field, and the explicit route is not a generated
coverage plan. The dry approach, application waypoints, return and stop use the shared v2 ground
mission graph with its real longest-path energy and endurance validation.

Material identity, batch, unit and initial quantity are explicit. Only water measured in litres and
inert granules measured in kilograms are modeled. Kilograms are material mass, not nutrient mass.
The application does not derive a chemical prescription from scouting NDVI or authorize a product.
Planning reports prescribed amount, available inventory and inventory sufficiency separately.

Water calibration records raw pulses, independently caught litres and duration. Pulses per litre
are `pulses / litres`; delivered volume is the cumulative pulse difference divided by that factor.
The spreader uses independent scale counts, a tare and a known inert mass. It does not infer
discharged mass from auger rotation. Calibration evidence is explicitly synthetic.

The requested quantity per second is `ratePerHa * groundSpeedMps * effectiveSwathM / 10000`.
For example, 200 L/ha at 0.5 m/s with a 0.8 m effective swath requires 0.008 L/s. The same dimensions
at 100 kg/ha require 0.004 kg/s. Zero speed, turning, a dry task, unsupported flow or an unqualified
footprint produces zero command. There is no positive minimum-flow floor at a stopped vehicle.
Meter resolution and transport latency constrain the configured no-delivery timeout. Closure
allowance includes primary/master response, energy decay, fall time and transport.

## Runtime and separate authority

The actual ground plant, raw sensors, estimator, qualified odometry, mission engine, vehicle
authority and independent modeled board watchdog execute in the shared vehicle runtime. A
seven-channel implement plant preserves the four existing drive/brake channels and adds primary
metering, independent master isolation and pump/auger energy. Valve positions, energy response,
available inventory and discharge evolve at the 4 ms physics step. Instruments render quantized
cumulative pulses, scale counts and actuator encoders from that state, with the existing delayed
measurement delivery. A 400 ms measured-flow window is separate from the requested flow.
The public plant accepts integer 1..10 ms steps and rejects fractional or overflowing clock advances
before mutation. Configuration and controller options are detached at construction.

The host controller consumes qualified estimated position/speed and measured instruments. It never
uses plant truth to choose a rate. A separate implement lease is scoped to visit, configuration,
material and estimator reference, with ordered grant/renew/revoke events and bounded monotonic
expiry. Vehicle arming does not grant implement authority. The fixture records the explicit
operator selection; these simulation grants do not authenticate a physical operator.

Before positive commands, the entire forecast footprint must be inside the field, inside one
prescription and outside exclusions. The guard expands for estimated position uncertainty, travel
during closure/transport, finite swath and wind/fall-time displacement. Weather freshness, wind,
temperature, humidity and inversion declarations are checked. Their configured limits describe
this model; they are not universal operating or product-label limits.

Empty inventory, inadequate measured delivery, invalid/replayed/stale instruments, failed barrier
position, unexpected residual flow, expired/revoked authority, emergency, guard, localization,
weather and vehicle-authority loss inhibit the implement and latch the failure. Restored data does
not silently reauthorize it. A stuck primary valve can be isolated by the independent master.
The persistent double mechanical failure deliberately leaves positive flow and unverified closure.
An off command is never presented as proof of no discharge.

Scenarios include nominal, empty, stuck-valve, master-stuck, blocked-flow, meter-loss, meter-replay,
weather, manual, host-loss, emergency, localization-loss, guard-open and lease-expiry. Fault scripts
wait for actual modeled material discharge before injection. A premature or dry run cannot count as
a successful metering-fault demonstration. A completed route with no discharge reports that fact;
it does not establish field application or coverage.

## Shutdown, dose and overlap evidence

An opt-in neutral tail evolves the independent board and plant after mission termination or host
loss. Its duration is at least two seconds and covers the declared closure allowance, barrier
response, eight energy time constants and material transport. Legacy vehicle profiles retain their
previous behavior by default. Tail probes do not
create host estimator observations, decisions or mission rows. Requested shutdown time, residual
emission, final barrier/energy/flow state and closure verification are retained separately. Empty
inventory loss is accounted as unmetered loss, not relabeled as delivered material.
New scenario faults can activate only during the live runtime phase. Faults already active at
shutdown continue through the independent tail, including persistent mechanical barrier failures.

Each retained release represents material actually integrated during a 20 ms interval, located at
its end-of-interval modeled plant position and yaw. Processing applies a uniform rectangular kernel,
displaced by declared wind times fall time, after its modeled landing epoch. This finite-stamp
model is not a measured spread pattern, continuous spray-transport solution or drift certification.

Exact polygon clipping computes treatable support and deposited amount in each retained grid cell.
Coverage is the union of deposited support. Repeated stamps in one pass do not inflate distinct-pass
overlap; overlapping different pass identities do. Prescribed quantity remains separate from actual
modeled deposited quantity. Cells retain field area including exclusions, excluded area, treatable
coverage, overlap, prescribed amount and dose per treatable hectare. Zero support remains visible.

Every emitted amount belongs to exactly one of treatable field, excluded support, outside field or
still in flight. The report retains their conservation residual rather than clipping losses away.
Independent modeled truth positions and coverage are explicitly different evidence from the host
measured-delivery estimate and its quantization uncertainty. No agronomic efficacy is inferred.

## Recording and replay

`application:replay` verifies the complete recording before inspecting an exact retained host or
independent probe epoch. `--at-ms` selects that epoch; the default is the last host input. A tail
epoch has no fresh host observation or decision. Mission decisions and implement inputs are replayed
through the actual policy, including lease scope, sensor counters, shutdown and material joins.
This checks unsigned internal consistency, not producer authenticity or byte-exact sensor/plant replay.

Exports use a new private directory, private exclusive files and a manifest published after synced
contents. They retain the source recording, computed report, cell geometry, measured ledger,
independent probes/releases, calibration, material, weather and local requirements. Reprocessing
uses the retained source. Existing directories are rejected. Complete artifacts contain synthetic
local positions and should not be treated as the location-free diagnostic journal format.

Limits are explicit: 32 vertices per ring, eight zones/exclusions each, 12 route points, 512 cells,
a 120-second planned mission budget, a 16 MiB recording and finite exact-geometry work/fragment
budgets. Exceeding a budget fails visibly; no silent downsampling or approximate geometry is substituted.
No database or background queue belongs in this deterministic control loop. Native Stacks CLI output
handles piped reports; the shared completed-artifact helper publishes datasets.

## Physical qualification remains open

Every configuration retains `localRequirements.status: unqualified`, an explicit operator and
optional jurisdiction/evidence links. `physicalTrialEligible` and `physicalApplicationVerified`
remain false. Before a physical trial, material-specific catch/scale and distribution calibration,
measured flow/response/closure, independent emergency/master isolation, field dose/overlap/drift,
current weather/product restrictions and jurisdiction/operator requirements need qualified evidence.
Board/transport and HIL campaigns must separately demonstrate the same failure behavior.

Engineering background includes [NC State calibration guidance](https://content.ces.ncsu.edu/water-quality-and-sprayer-and-spreader-calibration),
[material-specific granular distribution calibration](https://content.ces.ncsu.edu/calibrating-hand-held-granular-spreaders-for-nursery-weed-control),
[UGA spray factors](https://precisionagirrigation.extension.uga.edu/2022/06/spray-considerations-for-effective-pesticide-applications/)
and [Nebraska drift factors](https://extensionpubs.unl.edu/publication/g1773/2019/html/view).
These sources motivate separate delivery, distribution and weather evidence; they do not validate
our synthetic thresholds or establish local authorization. See [ADR 22](https://github.com/stacksjs/drone/blob/main/docs/adr/0022-prescribed-application.md).
