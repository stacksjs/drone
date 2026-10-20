# Simulated carried-load characterization

This is the first airborne physics prerequisite for [cargo issue #25](https://github.com/stacksjs/drone/issues/25). It characterizes a carried point mass and one prescribed split through our existing multirotor sensor, estimator, controller and authority loop. Delivery missions and physical release are still unimplemented.

```sh
./buddy cargo:load-bench
./buddy cargo:load-bench --scenario forward-carried
./buddy cargo:load-bench --scenario forward-separated
./buddy cargo:load-bench --scenario link-loss
```

The native Stacks command prints one compact JSON summary. The first three characterized cases exit 0. Link loss deliberately remains unqualified and exits 1, even when the full library result's separate `evaluation.faultCharacterizationPassed` observation is true. Invalid final scenario values, unavailable results and output failures exit 1 with a fixed generic error. Native parser usage errors also fail, using the parser's own diagnostics. An experiment ending in hover retains its actual simulated lease and nonzero motor values; it does not perform a landing.

Use `simulateCargoLoad({ scenario })` and `cargoLoadSummary(run)` from `resources/functions/drone/cargo/load.ts` for the full typed result and compact projection. The input accepts only an optional own-data `scenario` field: `centered-carried` (the default), `forward-carried`, `forward-separated` or `link-loss`. The library does not accept replacement plants, callbacks, gains or arbitrary control targets.

## Model and observations

The existing 1.5 kg quadcopter carries a 0.1 kg point mass, either centered or 0.08 m forward of its structural datum. The model integrates the combined center of mass and shifted inertia, then reconstructs structural-datum position, velocity and acceleration. Actual lagged motors supply the CG torque. Raw IMU/GNSS observations still pass through the unchanged estimator, controller and native authority model; the controller retains its original 1.5 kg feedforward.

Every case lasts 20 simulated seconds with a 4 ms body step, 20 ms policy step and 600 ms held support warmup. The full result retains 5,001 physical rows and 1,001 policy rows, distinguishing applied commands, actual motors and next commands. Counts include 151 held states and 4,850 integrated steps. Full rows, source capture/receipt epochs and final actual board state remain available in the library result.

`forward-separated` has exactly one separation opportunity at 12,000 ms. Admission requires current authority and board application, uninhibited controls, and 26 novel qualified IMU/estimate observations spanning 500 ms. The ordinary 12,000 ms rows precede the event. The first separated integration is at 12,004 ms; the first post-event IMU is captured at 12,020 ms, received at 12,024 ms and used by policy at 12,040 ms. GNSS follows its existing cadence.

The split is an instantaneous zero-ejection point-mass model. It preserves structural position, velocity, orientation, angular rate and actual motors without resetting the estimator, reference or controller. Independent tests check total linear/angular momentum, kinetic/potential energy and event continuity. No release mechanism, release acknowledgement, impact or parcel delivery is modeled.

In `link-loss`, the existing supervisor revokes authority and the board commands zero at 3,000 ms. Subsequent physical steps retain real modeled motor lag. The sole later split opportunity is refused and the load stays attached. Later ground contact is recorded as contact, with no landing or recovery claim.

## Qualification and bounds

Nominal cases require current authority, healthy qualified estimates, uninhibited control, no integrated contact, tilt at most 0.35 rad, angular rate at most 2 rad/s, and final 501-row position error at most 0.4 m maximum and 0.3 m RMS. Command slew uses independently checked binary64 rounded endpoints plus the raw reconstruction ceiling `40 + 2**-44` N/s. Raw maxima, including `40.000000000000014`, are preserved. This establishes neither an exact-real 40 N/s bound nor hardware compliance.

Each physical/policy row is limited to 2,048 JSON bytes, the row-free result to 131,072 bytes, the complete result plus LF to 12,582,912 bytes and the compact summary plus LF to 16,384 bytes. Rows are never truncated to fit. These are representation bounds, without a hard CPU or peak-memory guarantee.

The retained source qualification passed 38 tests and 5,553 assertions across controls, cargo and native CLI tests. All 17 immutable complete legacy no-load outputs remained byte exact. Scoped/application/runtime TS7 and Pickier passed. Source command tests cover native Buddy discovery, all four scenarios, invalid final options and closed stdout. Compiled executable and integration CI qualification are separate pending gates.

## Remaining roadmap

Issue #25 remains open, with its original acceptance criteria unchecked. Next work must add a delivery mission and site/recipient confirmation, verified release hardware and ACKs, custody, measured energy reserves and alternates. Redundant communications, degraded navigation, containment, diversion and fleet handover also remain open. Operational authorization, detect-and-avoid and physical/HIL evidence require their own documented qualification.

The result keeps `physicalFlightEnabled` and `identityAuthenticated` false, with physical board outputs inhibited. Its six delivery, mechanism verification, custody, recipient, mission and energy-margin capability flags remain false. This characterization does not authorize physical operation or long-range transport.
