# Owned range-backed navigation

Issue #11 adds perception, bounded route planning, selected metric-target intents and a navigation
supervisor above the owned mission/estimator/control/authority physics pipeline. Physical outputs
remain inhibited. The source is under `resources/functions/drone/navigation/`.

```sh
./buddy navigation:simulate
./buddy navigation:simulate --scenario replan
./buddy navigation:simulate --scenario range-loss
bun scripts/navigation-evidence.ts
```

The same command builds into the standalone Stacks CLI. `--seconds` is an integer 8..120. A normal
or replanning run must complete; deliberately faulted scenarios must block, or the command fails.
The public function returns mission and navigation traces; CLI output summarizes their row counts.

The private `createNavigationSession` in `navigation/runtime.ts` adds a retained vehicle
experiment for issue #24. It waits for one explicit `requestStart()`, consumes that attempt
even if refused, and advances on a bounded absolute virtual clock through `advanceTo()`.
The mission trace stops at its first terminal decision while the board, motor dynamics,
raw sensors and estimator continue. `stopHost()` instead stops every host update and
revocation; the independent board expires its last frame while cached host observations
remain explicitly stale. Invalid clocks permanently remove host launch eligibility.
Snapshots are detached copies. This single-attempt interface remains bounded to 120 seconds.

The separate private `createNavigationOccurrenceSession` accepts at most two distinct
`requestOccurrence({ id, issuedAtMs, decision: 'approve' | 'deny' })` attempts over a fixed
180 second experiment. Each fresh approval is bound at request and actual arm time;
refused, denied and overlapping identities remain consumed. Only a completed mission
with fresh grounded/stopped observations can admit another flight. Both flights share
the same body, raw feeds, estimator, controller, supervisor, watchdog, absolute clock
and nominal energy ledger. Completed per-occurrence results remain frozen and replayable.
These are unsigned local fixture decisions. Optional `contact: 'nominal'` adds a modeled
selected-pad contact check after completion. See [the contact model and its limits](patrol-contact.md).
Charging, recurrence, authenticated review, persistence, a patrol CLI and physical docking
remain open. See [ADR 27](adr/0027-retained-patrol-runtime.md).

## Data flow and references

1. The original synthetic range renderer produces quantized BODY_FRD vectors, capture/receipt epochs,
   sequence/reference identity, three visible arc samples per modeled cylindrical obstacle, three
   terrain samples and an explicitly named landing target. Plant truth is confined to rendering
   and independent evaluation. This is not a complete camera, LiDAR or occlusion renderer.
2. The detector consumes the estimator's capture-time pose, a declared identity mount calibration
   and uncertainty. It fits exclusion cylinders and a local plane, transforms the selected target
   into LOCAL_NED and computes observed virtual capture-to-receipt delay. Degenerate geometry,
   unavailable capture pose, partial coverage and unsupported evidence fail qualification.
3. A bounded visibility graph routes around inflated exclusion columns. A separate navigator checks
   position/authority, reference, origin, monotonic time, sequence and freshness; generates targets;
   and replans against new observations. It never arms or owns actuator IO.
4. The mission engine owns high-level takeoff, survey, return and landing acceptance. The navigator
   consumes the complete task goal, rather than the mission's direct target ramp. Position targets
   still pass the existing authority lease, controller gate and modeled board watchdog.

The mission remains a fixed-origin v1 reference. Navigation explicitly interprets its airborne goal
as a horizontal goal plus a declared terrain clearance. The fixture uses a shallow plane D=-0.03N,
1.2 m clearance and a landing site near the planned origin. The authored origin-relative survey
waypoint is [5,0,-1.35], so mission acceptance and navigation agree on altitude. This is not general
terrain-aware graph compilation.

The authored approach waypoint [2.5,-2.5,-1.275] splits the conservative detour into two legs.
Each leg retains the v1 20-second task limit and 500 ms settling requirement. This budgets the
route without relying on a platform choosing one side of an equal-cost path. The navigator still
computes obstacle clearance and the second detected column changes the return route.

## Constraints and planning

Range packets declare complete 360 degree modeled coverage within 8 m. Incomplete coverage is
rejected, and route vertices must stay inside the observed sphere after inflation. Columns conservatively
exclude all flight altitudes. There is no vertical overflight, unknown-space permission or inference
that missing detections imply a real sensor saw clear space. Up to eight cylinders produce at most
130 graph vertices; Dijkstra searches a circumscribed 16-point boundary around each inflated column.
Every candidate segment is checked against all columns. Horizontal fence and vertical center bounds
are checked separately; the altitude ceiling remains the existing authority/mission convention.
The renderer includes cylinders intersecting the coverage boundary. The navigator checks current
position and each command against the latest coverage on every tick, including between replans.

The clearance envelope is:

```
reaction = speed * (rangeAge + clockUncertainty + controllerDelay)
braking = speed² / (2 * assumedDeceleration)
clearance = reaction + braking + rangeAndPoseUncertainty + bodyRadius + trackingMargin
```

Capture/receipt delay is included in range age, not added twice. The detector adds three times the
sum of declared range and position sigma. The profile uses 0.5 m/s² assumed braking, 250 ms assumed
controller delay, 0.3 m horizontal body radius and 0.2 m tracking margin. Planning also budgets at
least 0.8 m/s and the full 200 ms age window, plus a separate 0.3 m path-following allowance.
Actual measured speed can enlarge that envelope. Targets ramp at 0.6 m/s. Replanning occurs at
least every 200 ms and immediately when the current segment is obstructed or the goal changes.
A 40 ms execution gap, invalid/stale/replayed range, reference/origin change, authority loss, speed
over 1.5 m/s, current braking-envelope intrusion or absent route latches release.
An inflated planning margin above the planner's supported 4 m limit also releases control.

These principles account for sensor and controller delays and prohibit unobserved directions,
consistent with [PX4's collision-prevention guidance](https://docs.px4.io/main/en/computer_vision/collision_prevention#cp-delay-delay-tuning).
This is an original planner and an assumed control envelope, not PX4's implementation or verified
physical stopping performance. On a fault the fixture disarms and zeros modeled thrust. This is
not a physical brake maneuver or emergency landing.

## Follow, orbit, RTL and precision landing

`navigationGoal` supports route/RTL, a fixed metric offset from an explicitly selected target,
and a speed-bounded orbit around that selected metric target. Target identity, reference and age
must match; loss never selects a different person. Image-space boxes are not accepted. Follow and
orbit geometry and loss behavior have public API tests; long-duration moving-target physics and
crossing/occlusion campaigns remain open.

Landing requires the selected site ID, less than 0.1 m declared uncertainty, agreement within
0.18 m of the planned site and a terrain slope below 0.07. The landing position is reconstructed
from range, not copied into policy from world truth. Its down target is constrained to D<=0 to
respect the origin-plane fence despite small measurement error. Missing, switched or inconsistent
sites release control. The modeled body contacts terrain through 10 cm landing gear. Physical
landing detection, sensor calibration and general slope-contact dynamics remain unvalidated.

## Evidence and remaining acceptance

The retained [report](navigation-evidence.json) contains seven scenarios generated by the public
physics function. Avoidance and replanning runs complete the owned mission, return and land within
3 cm of independent selected-site truth. The replanning case adds a second perceived column and
changes the actual return path. Fault cases verify range/position/site loss, delayed range and RC
takeover with neutral terminal board output. Public tests also cover fitted geometry, analytic
braking values, follow/orbit, terrain/fence conflicts and latched replay/reference/clock faults.

The nominal capture-to-receipt delay is measured as 60 ms on the **virtual fixture clock**. Range
and pose uncertainty, deceleration and controller-delay budgets are declared simulation assumptions.
No physical perception-latency or stopping measurement has been retained. A startup delay scenario
fails closed before a usable packet arrives, without claiming a measured 240 ms accepted stream.

Issue #11 remains open for physical range/camera extrinsic and time calibration, real coverage and
occlusion models, independently measured uncertainty and braking bounds, dynamic obstacle motion,
full terrain-aware mission semantics, long follow/orbit campaigns, HIL and hardware trials. Nothing
in this release enables physical flight. See [ADR 11](adr/0011-owned-navigation.md).
