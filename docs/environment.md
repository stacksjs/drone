# Synthetic airborne environmental sampling

This partial [issue #27](https://github.com/stacksjs/drone/issues/27) workflow acquires a scalar synthetic cell index through the owned multirotor mission, sensor, estimator, control and authority runtime. It includes calibration records, capture-time position, conditional uncertainty, unsigned provenance and reproducible local export. The unit `U` describes the digital fixture only. Physical atmospheric sensing, wildlife detection and operational authorization remain unqualified.

```sh
./buddy environment:simulate
./buddy environment:simulate --profile sensor-loss
./buddy environment:simulate --profile site-closure
./buddy environment:simulate --output /tmp/new-environment-dataset
```

The native Stacks command prints one bounded JSON summary. A demonstrated expected fault can exit 0 with `qualified:true` while preserving the native mission's `aborted` status and reason. Inspect both fields. An undemonstrated fault, unqualified nominal run, invalid input, unavailable result or output failure exits 1. `--output` requires a new destination with an existing parent. There is no overwrite or implicit retry.

The TypeScript library exposes `simulateEnvironment({ profile })`, `validateEnvironmentRun(run)` and `environmentSummary(run)` under `resources/functions/drone/environment/runtime.ts`. `writeEnvironmentDataset(directory, input)` creates and validates one fresh owned run before publishing. It never publishes a caller-supplied run.

## Mission and instrument

One native seven-task mission takes off, moves to a low sampling dwell, climbs to a second dwell, returns and lands. The plan uses a 100-second finite horizon and the existing 92-second worst-case mission/energy budget. Body dynamics run at 4 ms and the virtual instrument at 20 ms after the 600 ms support warmup. Sensor transport remains 60 ms, with a capture every 100 ms. Collection stops when the native runtime terminates; no post-retirement plant tail is fabricated.

The fixture's field is `40 + 2*north + east - 3*down + 4*sin(2*pi*t/10000)` U in fixed LOCAL_NED meters and milliseconds. The virtual detector has zero lever arm at the structural body origin. A discrete zero-order-hold cell with a 0.4-second time constant starts at the first actual render's field value. The 16-bit ADC uses 911 offset counts and 103 counts/U. Three reference standards determine calibration; separate held-out values and independent discrete convolution test the numerical model.

The conditional value bound is `0.01 + 0.5/103 + 0.25`, approximately 0.264854369 U, under the declared reference, quantization and clock/slew assumptions. It applies to the filtered cell state. Capture-time estimated position, covariance and source epochs accompany each admitted observation. The fixed origin is latitude/longitude 0/0 with WGS84 ellipsoid height 100 m; these coordinates are synthetic. Model payload mass, power, drag and rotor wash are not qualified.

## Faults and review

`sensor-loss` suppresses detector captures from 5,000 ms and demonstrates stale admission/native abort at the declared 5,060 ms deadline. `site-closure` applies a collection-policy revision at 8,000 ms, checks current estimated position with its uncertainty margin and requests native abort before later collection. It does not mutate the native mission geofence. Both cases retain earlier genuine airborne observations, causal retirement records and zero current board commands, without claiming a subsequent physical landing.

The initial declared zone and later site closure demonstrate collection constraints only. Wildlife disturbance distances, detected wildlife, anti-poaching authority and real site authorization remain unverified. Every result requires human review. The custody chain consists of unsigned content-linked digital observation records; it supplies no authenticated physical sample identity or transfer.

## Completed dataset

A successful publication contains exactly five private files:

| File | Content and fixed cap |
| --- | --- |
| `mission.json` | Canonical native replay trace, at most 6,001 rows and 8 MiB |
| `diagnostics.ndjson` | At most 5,001 instrument rows, 512 bytes/row and 3 MiB total |
| `packets.ndjson` | At most 1,001 scheduled packet/disposition records, 512 bytes/row and 512 KiB total |
| `observations.ndjson` | At most 1,001 observation/custody pairs, 2,048 bytes/row and 2 MiB total |
| `manifest.json` | Model, policy, calibration, native outcome, counts, hashes and actual Bun identity, at most 16 KiB |

JSON/NDJSON byte measurements include LF. The five-file aggregate and complete run each have a 16 MiB cap; the CLI summary has a 16 KiB cap. Own-data traversal bounds property keys, encoded JSON string tokens, node count and depth before full serialization. String-token accounting is a subtotal, with separate full-result/file checks. These limits do not establish hard CPU, allocation or peak-memory bounds for arbitrary objects.

The unchanged completed-directory publisher uses exclusive files, private modes, file/directory fsync and a final manifest link. Validation, hashes and all budgets precede destination creation. Existing destinations remain untouched. A final manifest is a content/completion marker, without a hardware power-loss or authenticated-custody guarantee. The manifest embeds a summary with `dataset:null`; only the successful caller receipt includes its destination, final manifest hash and aggregate bytes.

Two fresh nominal exports were byte identical on the same actual Bun version/revision. Cross-version reproduction needs separate evidence. Native mission replay, independent calibration/field/position tests, real source CLI behavior and output-failure handling are covered by the source qualification. Compiled executable and integration CI qualification are separate gates.

Issue #27 remains open with its original criteria unchecked. Measured sensors/calibration/clock/heading, physical sample custody, human-reviewed wildlife/anti-poaching workflows, broader payload faults and actual geofence/operational behavior still require implementation and qualification.
