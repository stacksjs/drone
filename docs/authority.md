# Owned authority and failsafe supervisor

Issue [#6](https://github.com/stacksjs/drone/issues/6) now has a version 1 simulation supervisor
above the owned estimator and multirotor controller. A separate modeled output watchdog expires
thrust if the simulated host stops executing. This is software evidence, not HIL or a physical
kill circuit. The Pico firmware remains neutral-only and the physical adapters remain receive-only.

```sh
./buddy authority:simulate --scenario nominal --seconds 20
./buddy authority:simulate --scenario pi-loss --seconds 8
./buddy authority:simulate --scenario kill --seconds 8
bun run runtime:cli
./storage/runtime-build/cli/drone authority:simulate --scenario board-reset --seconds 8
bun tests/fixtures/authority/evaluate.ts
```

The native Stacks `defineCommand()` is shared by Buddy and the standalone binary, including outside
the checkout. Duration is 4..60 virtual seconds. The library lives in
`resources/functions/drone/authority/`; no database, scheduler job, network endpoint or hardware IO
is involved. Database queues and Linux scheduling do not implement the deadline or independent
watchdog. Existing `controls:simulate` remains the isolated controller baseline; `authority:simulate`
adds supervision to that same physics, sensor, estimator and controller path.

## State machine version 1

Startup is `disarmed`. Arming never starts motors; engagement is a separate explicit action.
This first profile supports only position control in the declared synthetic heading frame.

| Current state | Accepted operator actions and resulting state |
| --- | --- |
| disarmed | arm: armed-idle; disarm: disarmed; kill: killed |
| armed-idle | engage: autonomous; disarm: disarmed; kill: killed |
| autonomous | renew: autonomous; disarm: disarmed; kill: killed |
| manual | disarm: disarmed; kill: killed |
| failsafe | reset: disarmed; kill: killed |
| killed | reset: disarmed; kill: killed |

All other pairs are rejected without granting or extending authority. Existing autonomous authority
retains only its previous finite lease. The tests check all 36 pairs independently of the exported
transition map. `manual` revokes autonomous thrust and latches after the override switch is released.
There is no RC stick controller yet. A fresh RC disarm switch also moves armed-idle, autonomous or
manual to disarmed. New arm and engage commands are required to resume.

Independent events take priority over commands:

1. A modeled kill input latches killed, even if the supplied clock is invalid. Its event retains the
   last trusted timestamp. Releasing it or sending disarm does not clear the latch.
2. Clock reversal/non-finite time, a supervisor gap greater than 40 ms, board boot mismatch,
   runtime-watchdog failure, stale interlocks, RC loss, link loss, battery reserve, estimator loss,
   reference reset or fence breach move an armed state to failsafe. Hazards also apply in manual;
   a zero-thrust fall can therefore escalate manual to failsafe. Killed retains priority.
3. Healthy RC disarm and then override are evaluated. Override selects manual and revokes the lease.
4. An autonomous command lease expires at its boundary, before a late renewal can be considered.
5. If no independent transition occurred in this update, a correctly scoped operator command can attempt a legal transition with all applicable guards. Commands pending during an independent transition are ignored.

The exported map and bounded last-64 transition events make decisions reviewable. Snapshots clone
mutable data. Snapshots do not advance time or refresh health. After simulated Pi termination the
last supervisor snapshot can still say autonomous: `hostAlive: false`, `lastHostCheckMs` and the
independently expired board lease show that it has stopped executing. No final host command is
fabricated.

## Commands, health and output leases

Each command carries version, session ID, boot ID, revocation epoch, monotonically increasing uint32
sequence and local issuance time. The fixture supplies explicit IDs; these scope trusted in-process
commands and **are not network authentication**. Invalid scope, replay or stale/future issuance while
armed revokes authority. Sequence high-water persists across state changes. Every state change
increments the epoch, invalidating earlier commands. Start a new session before counters exhaust.

Commands must be at most 100 ms old. Engage/renew lease duration is 20..100 ms and expiry is
`issuedAtMs + leaseMs`, never receipt time plus duration. Renewals contain a complete position/yaw
target and require the current epoch. There is no automatic re-engagement after timeout or recovery.
Targets and estimated current position must lie within a 20 m horizontal radius and NED down
[-10,0] m, relative to the fixed simulation origin. Yaw must be finite within [-pi,pi]. These fixed
bench bounds do not account for uncertainty, terrain, braking distance or actual airspace.

| Input | Maximum age and required state |
| --- | --- |
| Runtime status | 20 ms; expected boot and healthy modeled watchdog |
| Kill/ground/motor interlocks | 20 ms; kill has unconditional asserted priority |
| RC | 100 ms; connected; arm switch on to arm/engage |
| Companion link | 150 ms; connected |
| Battery | 500 ms; finite 0..100 percent, greater than 25 percent reserve |
| Estimator | Evaluated at exactly the supervisor tick; fixture, healthy tilt/local position |
| Attitude and local position | 60 ms attitude, 200 ms position capture, 40 ms prediction; valid frames/quaternion/origin |

Boot, origin and estimator reset counters bind at arm. Estimator changes while armed revoke authority.
A board reboot requires a fresh supervisor session against the new boot and requalified estimates;
old commands and frames cannot resume it. Reset after failsafe/kill requires healthy fresh inputs,
kill released, RC arm/override off, ground contact and stopped modeled motors. Reset only returns
to disarmed. These are modeled interlocks, not independently measured physical ground/stopped proof.
Arming also requires ground, stopped motors, RC arm on and no override/kill.

The gate accepts exactly one controller output at the current observation time. Controller outputs
now carry `atMs`; an old output, duplicate gate, inhibited output or invalid motor vector revokes
authority. Only a current autonomous decision can produce a versioned frame scoped to boot/session/
epoch/sequence. Values are modeled newtons, bounded [0,10] per motor, never PWM or DShot.

The independent modeled board consumes those frames using its own monotonic clock and sequence
high-water. Frames expire after at most 60 ms and never beyond the authority lease. Invalid frames,
replay, clock reversal or timeout latch zero output. Reboot clears outputs and requires a strictly increasing simulation boot ID;
ordinary revoke only zeros output. No late frame clears a watchdog fault. Motor lag in the plant
means zero command does not instantly remove existing thrust. A zero-thrust fall is not a safe
landing strategy for a real aircraft.

## Reproducible scenarios

The [retained report](authority-evidence.json) records a 20-second nominal step and eight-second
fault runs, with injection at 3000 ms. RC override/kill pulses last 100 ms; their release never
restores autonomous authority. IMU capture loss lasts 3000..3400 ms; resumed packets do not rearm.
Other scenarios cover disconnected RC/link, reserve battery, an out-of-fence target, disarm,
board reset, watchdog trip and stopped command renewal. Unit tests separately cover current-position
fence breaches, stale inputs, all transition pairs, output/command replay and recovery.

In the Pi-loss run, all host sensor-pipeline, estimator, observation, renewal and controller calls stop at 3000 ms. The board
expires the last motor frame at 3040 ms using only its independent ticks; the last host check was
2996 ms. No state-machine transition is attributed to the dead host. In lease-loss, output and
command expiry coincide at 3080 ms, so the board watchdog is the first observed cause. Sensor loss
revokes at 3044 ms. Most direct inputs revoke at the injection tick. These are deterministic model
results, not measured hardware latencies. Nominal feedback retains the previous control baseline.

## Deferred requirements and completion gates

| Capability | Status and next evidence |
| --- | --- |
| Physical kill/disarm, RC decoding and output isolation | Deferred in #6. Independent circuitry, bus-loss behavior, electrical neutral state and measured disabled-load evidence |
| Native board authority port | Deferred in #6 after #2/#3/#4/#5 prerequisites. Bound memory/timing, session handshake, reset and clock/counter campaigns |
| Hardware-in-loop loss campaign | Deferred in #6. Real RC loss/override, Pi SIGKILL/power removal, board reset, stale UART, sensor faults, low voltage and reserve calibration |
| Emergency landing, return/rally/recovery | Deferred in #6/#10/#11. Explicit mode policy, energy/terrain/heading prerequisites, trajectories, degraded estimates and independent recovery evidence |
| Parachute | Deferred in #6/#8. Supported device contract, firing inhibition, altitude/attitude/energy envelope, independent trigger and ground-test procedure |
| Redundant links | Deferred in #6/#7/#25. Authentication, arbitration, independent failure domains, replay protection, handover and simultaneous-loss tests |
| Manual sticks and alternate vehicle modes | Deferred in #5/#6/#12. Vehicle-specific manual controller and priority/mode transition tests |

The issue stays open. No arming endpoint or physical actuator protocol is introduced. Existing
external-driver failover and authority remain separate until an explicitly validated integration.
Primary behavior context: [PX4 safety configuration](https://docs.px4.io/main/en/config/safety),
[PX4 arming lifecycle](https://docs.px4.io/main/en/advanced_config/prearm_arm_disarm) and
[ArduPilot failsafe overview](https://ardupilot.org/copter/docs/failsafe-landing-page.html).
No upstream implementation is copied or treated as evidence for this supervisor.
