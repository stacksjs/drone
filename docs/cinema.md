# Simulated POI camera reframe

This partial [issue #26](https://github.com/stacksjs/drone/issues/26) tracer coordinates an ordinary owned takeoff/hover/land mission, a lagged three-axis gimbal and three modeled still captures of one selected synthetic point of interest. It implements a smooth angular reframe while hovering. Broader dolly/orbit paths, physical cameras/gimbals, lens/exposure control, video timecode and operator handoff/resume remain open.

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

## Owned selected gimbal source

`simulateManagedCinema(input: unknown = {})` is a separate library function in the same runtime. It returns a concrete v2 `CinemaManagedRun`; `simulateCinema`, all v1 types and the seven existing CLI scenarios retain their contract. There is no managed CLI command. The managed function accepts only `nominal` or `source-expiry-with-foreign` in the same closed own-data scenario envelope. Invalid envelopes throw the fixed `cinema-managed-input` TypeError; unavailable results retain `cinema-unqualified-result`.

The managed path runs the same single mission, plant, delayed encoder, PD controller, renderer and shutter ledger. It explicitly selects the immutable in-process writer `autonomy:cinema-autonomy-v1` in session `cinema-gimbal-source-v1`, epoch 1 and reference `55:0,0,0,0,0`. The writer submits estimated relative BODY_FRD joint roll/pitch/yaw angles every 20 ms with an 80 ms issuance-based lease. Holding an admitted angle still recomputes the existing PD request from each current delayed encoder. It does not hold an old torque. Manager activation starts during the unchanged in-loiter readiness accumulation; startup outside that qualified goal path does not warm a lease.

In `source-expiry-with-foreign`, selected updates stop after shot start plus 940 ms. At plus 1000 ms a fixed fresh foreign operator packet is refused without replacing the selected token or extending its expiry. The first real exposure occurs then under the cached selected angle. At plus 1020 ms the original lease expires before a returning selected renewal and before polling the first ACK. The actual image remains uncertain with `gimbal-source-expired`, `ack:null` and zero ACK receipts. The same cause appears in managed run, shot and capture; native mission reason remains its actual `operator-abort`. The original retirement owner closes tracking/shutter requests and retains the actual 501-row residual-motion tail. No callbacks after world termination are fabricated.

Managed evidence records policy, fixed selection, last accepted token, first inhibit, normal retirement, admission/rejection counters, state transitions, per-exposure token joins and at most one fixed foreign rejection. Accepted source commands are admissions, not necessarily applied PD requests: an admission at shot completion precedes normal close. Nominal completion has no manager fault, three admitted qualified captures and an actual landed, neutral native mission. Manual/neutral tests exercise the public manager's directive and latch; the integrated source-expiry scenario exercises modeled retirement. They are different evidence seams.

Manager JSON plus LF is bounded to 12,288 bytes, with at most 16 transitions and 3 exposure joins, not a policy-row transcript. The disjoint component budget is 9,856 bytes. A 16,384-byte extension reserve covers that evidence and the fixed v2 marker/key differences, which require fewer than 4,096 bytes. The original non-native derivation 11,897,216 plus that reserve is 11,913,600 bytes; with the 8,388,608-byte native allowance, total 20,302,208 leaves 669,312 bytes under both original aggregate guards. All original row/image/component and actual 12/20 MiB guards remain enforced. None is a CPU, memory or physical timing guarantee.

This manager provides no authenticated identity, source transfer/resume, rate command, firmware lock mode, physical driver, MAVLink manager protocol or independent watchdog. Source loss is modeled while the host policy loop survives. Zero requested torque preserves current joint position/rate/applied torque at retirement; it does not prove electrical isolation, braking or host-death protection. Issues #8/#26 and upstream unsupported classifications remain open.

## Bounds and remaining work

The native trace is limited to 6,001 rows and 8 MiB. Cinema-specific records/images have a 12 MiB bound; the full JSON run plus LF has a 20 MiB bound and the CLI summary plus LF a 16 KiB bound. Data is neither rounded nor truncated to pass. These representation limits establish no hard CPU or peak-memory bound. Source, compiled-executable and CI qualification are tracked separately.

`physicalFlightEnabled`, `physicalGimbalActuationEnabled` and `identityAuthenticated` remain false. These synthetic stills establish no measured optical calibration, physical shutter/gimbal accuracy, lens/exposure behavior, broadcast/video timing or operational readiness. All original issue #26 acceptance criteria remain unchecked. Broader smooth translational paths, physical integration, broader interruption/recovery, handoff and synchronized video/lens controls need further implementation and evidence.

## Counted encoder prerequisite

`measureCountedCinemaEncoder(input)` in `cinema/counted-encoder.ts` differentiates integer
encoder counts before converting to radians per second. Its fixed method metadata is exported
as the frozen `cinemaCountedEncoderMethod`: 0.001 rad per count, 20 ms sampling and delay,
and 0.05 rad/s per count difference. One count in either direction therefore meets the same
strict `<= 0.05` rate predicate; two counts fail it. It does not round a reported rate or add
an epsilon to that predicate.

Input is exactly `{ current, previous }`. Each tick contains `sequence`, `capturedAtMs`,
`receivedAtMs`, three integer `positionCounts` and boolean `limitSwitch`. Both ticks must match
the global cadence beginning at sequence 1, received 600 ms and captured 580 ms. The first
previous tick is null; later ticks require the immediately preceding tick. Counts are bounded
to +/-8,000 and reject negative zero. Plain own enumerable data and ordinary dense tuples
are required. Malformed data throws `cinema-counted-encoder-input`; constructed output or
owned-producer invariant failure uses `cinema-unqualified-result`. Returned count, delta,
position and rate tuples are detached. These declared inputs are simulated measurements,
without authentication or hardware qualification.

`createCountedCinemaGimbal()` in `cinema/gimbal.ts` is a separate owned producer over the same
4 ms plant and unchanged PD law. It quantizes the actual delayed physical row into counts,
canonicalizes zero and retains its current measured packet privately. Call `render(nowMs)`
first, then `command(goal, nowMs)` once a differentiated rate exists. The command accepts no
caller-supplied measured packet. Goals must be ordinary dense finite three-tuples inside the
existing joint travel; invalid commands and epochs fail before changing the request. Repeated
valid commands at the current epoch retain last-request-wins behavior.

The counted producer's `rows` accessor, `current()`, `render()` and `tail()` return deep owned
snapshots. Mutating them does not alter future feedback or plant state. `retire(nowMs)` stops
requests at the current rendered epoch and `tail()` returns the actual 501-row residual
motion calculation. The published `createCinemaGimbal()` retains its three-argument
`command(goal, measured, nowMs)`, floating-radian differentiation and direct mutable `rows`
alias. Its existing Cinema v1 and managed v2 callers continue to use that legacy measurement.
The two concrete arms share one plant implementation; counted feedback can produce a
different trajectory and is not an equality claim for the new arm.

The counted packet remains bounded to 512 encoded bytes, with 768-byte plant rows, at most
11,251 live rows, 501 tail rows and the unchanged 45,000 ms horizon. This prerequisite tests
count/cadence semantics, actual owned producer behavior, command provenance, copying and
legacy output compatibility. It adds no translating-camera consumer or CLI command. Camera
readiness, moving images, full-flight acceptance, physical feedback, host-death protection
and issue #26 completion require separate evidence. The original failed 1,600 ms translating
camera result remains failed; no window, threshold, gain or dynamics was changed here.


## Counted translating camera simulation

`simulateCountedTranslatingCinema(input: unknown = {})` in `cinema/runtime.ts` has a separate
outer v4 `CinemaCountedTranslationRun`, audit v3 and actual native v4 mission trace. The fixed
`straight-poi-dolly-counted-v1` profile uses the counted encoder producer and the same optical,
source-manager and plant flow. Its closed own-data input accepts `nominal` or
`source-expiry-with-foreign`; omitted scenario selects nominal. Invalid input throws the fixed
`cinema-counted-translation-input` TypeError. Unavailable owned results use
`cinema-unqualified-result`. It adds no hardware driver. The counted command is described below.

The original first nominal acquisition is accepted after a separately reviewed saved-result
decoder field-order correction. The original failed oracle receipt and full first result remain
preserved. The corrected saved-only oracle passed all 47,637 expectations, using the same actual
acquisition. It verified the original 1,600 ms readiness window, 26 samples across 500 ms,
strict 0.05 rad/s counted rates, native admission, the full 2 m plan, all three actual moving
images within 2 pixels, positive forward speed, at least 0.5 m capture progress, 8 s close,
actual return/landing, neutral board, replay, count joins and bounded residual tail. These are
simulation observations, without physical flight, gimbal actuation, authentication, SITL/HIL,
real-time performance or production qualification claims.

The first actual source-loss acquisition and saved-only oracle passed with one test and
23,478 expectations. The selected token issued at 6,560 ms expired at 6,640 ms; the foreign
packet was rejected at 6,620 ms while the cached token produced the real first image. At
6,640 ms expiry won before selected renewal and ACK. Run, shot and uncertain capture retain
`gimbal-source-expired`; the image has no ACK, and the actual native mission ended with
`operator-abort`, neutral outputs and the 501-row residual gimbal tail. Independent audit
joins verified strictly positive first-image displacement and forward speed.

The bounded public input and ownership tests also passed, with two tests and 37 expectations.
All 20 fresh complete legacy outputs match their before captures byte for byte, including
final LF and reversible BigInt paths. At that first local checkpoint, full-suite,
compiled-command, browser, exact-head CI and main-publication gates remained pending.
Those library-candidate gates subsequently passed, and commit
`a75c06554ea1eaebc34892dc90c97198d5d3228e` was published to main. Its compiled checks exercised
existing commands; the new counted command below requires its own qualification. These
results establish simulation behavior only. The old failed translating-camera candidate
remains failed and unchanged.


## Counted translation command

The native Buddy command and portable CLI entry expose the fixed counted dolly simulation:

```sh
./buddy cinema:translate
./buddy cinema:translate --scenario source-expiry-with-foreign
# After building the runtime CLI:
/path/to/drone cinema:translate --scenario nominal
```

Only `nominal` and `source-expiry-with-foreign` are accepted. The command invokes
`simulateCountedTranslatingCinema` once with that scenario. Its mission, selected writer,
counted encoder, optical renderer and capture schedule remain the library's fixed profile.
It accepts no user plan, hardware driver, timing or gain controls, provider or output directory.
The existing seven `cinema:simulate` hover scenarios retain their interface.

Stdout is one compact JSON summary plus LF, at most 16 KiB including LF. The distinct
summary v1, `owned-counted-cinema-cli-summary`, identifies the actual library run v4,
translation audit v3 and native mission v4. It retains the count-difference method, terminal
mission state, board neutrality, shot and source-manager facts, admission timeline,
translation metrics and per-capture quality, body position and counted measurement.
It omits image pixels, full model, trace rows, plant rows, encoder ledgers and the full
readiness suffix. This summary is not a recording or independent replay verification.
Vehicle smoothness remains unqualified; the motion evaluation describes the modeled gimbal.

A completed run exits 0. Every returned halted, incomplete or failed run still prints its
actual summary and exits 1. The intentional source-expiry scenario therefore exits 1 and
retains `gimbal-source-expired`, the uncertain exposure without ACK, and native
`operator-abort`. Handler input, unavailable-result and output errors use a fixed bounded
stderr message and exit 1. Native parser usage errors retain their own handling.

The command's 19 public CLI tests passed locally on pinned Bun 1.4.2, including actual
public-result mapping, native input handling, delayed consumption and closed stdout.
Default and explicit source/Buddy summaries match byte for byte. Both scenarios also
passed through a compiled macOS arm64 executable copied outside the checkout, with
project, dependency and installed Bun reads denied and a system-only PATH. Its complete
stdout matches the native entry paths, preserving actual exits 0 and 1. All seven legacy
cinema summaries and exits remain byte-identical through source, Buddy and that executable.
This is host-target delivery evidence; full-suite and exact-head CI receipts are tracked
separately in issue 26. Existing independent library qualification remains separate.
No physical flight, gimbal actuation, authentication, firmware SITL/HIL, real-time
performance or issue 26 completion is established by the command.
