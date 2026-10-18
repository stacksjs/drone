# Local ArduCopter SITL integration

The browser and terminal simulator need no other software. This page concerns the optional real
MAVLink wire adapter tested against protocol fixtures and a local UDP peer, not a completed SITL
flight certification. **A full ArduCopter SITL flight has not been run for this release.**

Install the current ArduPilot SITL prerequisites from the [official guide](https://ardupilot.org/dev/docs/SITL-setup-landingpage.html).
On a supported Linux host, start a quadcopter simulation using ArduPilot's normal tooling and forward
MAVProxy output to this project's receiver:

```sh
sim_vehicle.py -v ArduCopter -f quad --console --map --out=udp:127.0.0.1:14551
```

Launch on the **same host**, with no hardware link attached or forwarded:

```sh
bun run sitl --enable-sitl
```

The runner listens for a system 1/component 1 ArduCopter quadcopter heartbeat. The first matching
heartbeat pins the local UDP return port. MAVProxy must accept replies on that output and deliver
them to SITL. Verify routing in your installed version and inspect incoming setpoints in the simulator.
The script does not arm or take off. In the simulator's ground station, select Guided, arm, take off
to 12 m, and verify local position before beginning a run. The synthetic pilot is 20 m north of
EKF origin, facing north; the intended follow point is 10 m north at 12 m altitude.

The runner lasts at most 30 seconds and streams at 5 Hz while its local lease is renewed.
Loss of target produces zero-velocity setpoints. Missing/stale telemetry, manual mode or low battery
stops the stream. Verify the autopilot's own Guided timeout and battery/link/RC responses separately.
Stopping the stream does not immediately force a mode change.

Use separate runs for normal follow, stale telemetry, target loss, wrong peer/system, mode change,
unknown battery, link failure and abrupt Pi termination. Confirm independent RC override and fence
behavior in SITL before designing any physical command adapter.

Protocol references: [ArduCopter Guided commands](https://ardupilot.org/dev/docs/copter-commands-in-guided-mode.html),
[MAVLink common messages](https://mavlink.io/en/messages/common.html),
[packet serialization](https://mavlink.io/en/guide/serialization.html).
