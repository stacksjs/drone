# Simulated POI camera reframe

This partial [issue #26](https://github.com/stacksjs/drone/issues/26) tracer coordinates an ordinary owned takeoff/hover/land mission, a lagged three-axis gimbal and three modeled still captures of one selected synthetic point of interest. It implements a smooth angular reframe while hovering. Translational dolly/orbit paths, physical cameras/gimbals, lens/exposure control, video timecode and operator handoff/resume remain open.

```sh
./buddy cinema:simulate
./buddy cinema:simulate --scenario body-disturbance
./buddy cinema:simulate --scenario target-loss
./buddy cinema:simulate --scenario mechanical-limit
./buddy cinema:simulate --scenario camera-loss
./buddy cinema:simulate --scenario wrong-ack
./buddy cinema:simulate --scenario rc-override
```

The native Stacks command accepts these seven closed scenarios and prints one compact JSON summary. Only `status:completed` exits 0. Other representable outcomes exit 1 and retain their own reason and actual native mission state. Invalid final options, unavailable results and output failures fail; native parser usage errors retain native diagnostics. No file-export option is implemented.

`simulateCinema({ scenario })` in `resources/functions/drone/cinema/runtime.ts` returns the detached JSON-domain run, including actual gimbal rows, delayed encoder observations, correlated captures and native mission trace. Input is an optional own-data primitive scenario field, with `nominal` as default. It accepts no caller-selected world, torque, gain, target, clock, camera callback or capture schedule.

## Owned motion and image path

One unchanged native mission takes off to LOCAL_NED `[0,0,-1.2]`, loiters and lands. Its fixed origin is latitude/longitude 0/0 and WGS84 ellipsoid height 100 m. Body dynamics run at 4 ms; estimator, mission and instrumentation decisions run at 20 ms. A 500 ms readiness window requires fresh qualified estimated vehicle/target/encoder data and current authority before the shot can start. There is one bounded start window, without retry/rearm.

The nominal selected synthetic POI is `[4,0,-1.2]`. The `mechanical-limit` case selects `[0.1,4,-1.2]` to exercise an unreachable goal. A fixed smooth angular reference moves 8 degrees out over three seconds, returns over three seconds and holds for two. The vehicle's ordinary mission retains control of translation. The private gimbal plant includes inertia, damping, bounded/slewed torque and a 20 ms delayed 0.001 rad encoder. Controller goals use estimated body attitude; image generation uses the actual exposure-time body and current joint pose. These are distinct from the requested orientation and delayed encoder.

The forward-looking pinhole model has 64x48 pixels, focal lengths 40 pixels and principal point `[32,24]`. A fixed asymmetric colored marker supplies independent pixel geometry checks. Three shutter requests occur 1, 3 and 7 seconds after shot start. Normal modeled acknowledgements arrive 20 ms later, with an inclusive 80 ms deadline. Captures retain session/reference/sequence and exposure-time actual pose, estimated pose, current joints, delayed encoder, image and ACK metadata. Quality compares independently observed marker centroid to the intended pinhole position within two pixels.

The renderer samples constant colors at pixel centers. Distinct continuous poses can produce identical raster bytes. A disturbance therefore need not change a pixel to be physically represented; independent actual-pose reconstruction and deliberately distinguishable geometry controls are the relevant image-sensitivity checks. The fixed disturbance changes actual body torque through the existing physics loop, without editing recorded poses or images.

## Loss and retirement

Target selection is explicit. `target-loss` withdraws updates so the first stale-target decision coincides with the first expected ACK. The target fault wins before polling that ACK; the exposed image remains uncertain, with no later shutter request or target switch. `camera-loss` and `wrong-ack` preserve missing/incorrect acknowledgements rather than retrying an ambiguous exposure. `mechanical-limit` preserves the joint fault; `rc-override` uses native authority takeover.

The first fault remains latched. Retirement stops new tracking and shutter requests, keeps actual native terminal/board observations and records a separate two-second gimbal tail under neutral requested torque and the unchanged slew/plant dynamics. It does not fabricate a future vehicle landing, instantaneous joint stop or physical recovery. A halted shot cannot become completed merely because the vehicle later lands or an image exists.

Motion qualification checks actual 4 ms rows, including the tail boundary: angular rate at most 2 rad/s, acceleration at most 4 rad/s^2, jerk at most 6 rad/s^3 and torque slew at most 0.02 Nm/s under the declared numerical tolerance. Native mission completion/landing, neutral board commands, exactly three confirmed and admitted quality frames, and successful capture/native-row reconciliation are also required for completion. Frames marked uncertain remain uncertain.

## Bounds and remaining work

The native trace is limited to 6,001 rows and 8 MiB. Cinema-specific records/images have a 12 MiB bound; the full JSON run plus LF has a 20 MiB bound and the CLI summary plus LF a 16 KiB bound. Data is neither rounded nor truncated to pass. These representation limits establish no hard CPU or peak-memory bound. Source, compiled-executable and CI qualification are tracked separately.

`physicalFlightEnabled`, `physicalGimbalActuationEnabled` and `identityAuthenticated` remain false. These synthetic stills establish no measured optical calibration, physical shutter/gimbal accuracy, lens/exposure behavior, broadcast/video timing or operational readiness. All original issue #26 acceptance criteria remain unchecked. Smooth translational paths, physical integration, broader interruption/recovery, handoff and synchronized video/lens controls need further implementation and evidence.
