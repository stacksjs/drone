# Finite patrol simulation command

`patrol:simulate` composes the native cron review ledger with one retained simulated vehicle.
With no decision file it runs the complete 180 second experiment with zero flight requests,
accepted arms or charge frames. The two due slots expire without granting authority.

```sh
./buddy patrol:simulate
./buddy patrol:simulate --decisions examples/patrol-decisions.json --unsigned-local-review --enable-charge
```

The same native command definition is registered in the portable `drone` entrypoint.
Build it with `bun run runtime:cli`. Its compiled entrypoint uses the existing disabled
bunfig, dotenv, tsconfig and package auto-loading flags.

The example explicitly reviews the first flight at 2 seconds, separately approves partial
charging at 47 seconds, then reviews the second flight at 60 seconds. The fixed UTC anchor
is 2026-01-01T00:00:00.000Z. These are unsigned synthetic decisions, without authenticated
operator identity. The nominal model completes flights at 44.120 and 102.120 seconds,
verifies their own selected-pad contact, and proves modeled charge isolation at 55.400 seconds.
See the [recurrence](patrol-recurrence.md), [contact](patrol-contact.md) and
[partial-charge](patrol-charge.md) contracts for their fixed models and limits.

## Decisions and native options

A file has exactly `version: 1`, `profile: "nominal"` and `decisions`. It contains at most
four ordered events, with at most two flight and two charge events. Each event has five fields:

- Flight: `kind`, `id`, `atMs`, `dueUtcMs`, `decision`.
- Charge: `kind`, `id`, `atMs`, `occurrenceId`, `decision`.

`kind` is `flight` or `charge`; `decision` is `approve` or `deny`. IDs are globally unique
lowercase identifiers, starting with a letter, with at most 40 letters, digits or hyphens.
`atMs` is a multiple of four from 0 through 180000. Flight due times are 1767225600000 or
1767225660000; each tuple appears at most once. Charge occurrence IDs are `patrol-slot-zero`
or `patrol-slot-one`. Times must be nondecreasing. Events retain supplied order at equal times; a queued flight or charge
reservation prevents a conflicting later approval from being adopted after recovery.

Any decision file requires `--unsigned-local-review`. A charge event additionally requires
`--enable-charge` and its own explicit decision. Neither flag creates an event. Empty files
with the exact valid wrapper and an empty decisions array remain neutral previews.

Options use the installed native Stacks parser. The handler validates its final normalized
values. Repeated bare booleans follow native normalization, including an explicit later bare
true replacing an earlier string false. A final actual negative cannot supply an opt-in;
a standalone string false and repeated value arrays are rejected. Supply each opt-in once
for clear intent. Unknown options and missing values retain native nonzero usage exits.
Handler validation, failed decisions and output errors exit with status 1.

The whole input is validated before creating the experiment. Files must be regular,
non-symlink UTF-8 files of at most 8192 bytes. Malformed UTF-8, a byte order mark, excess fields,
invalid last events, directories and FIFOs are rejected without running the model. The function
interface also requires dense own data arrays and rejects accessors, symbols and extra fields
without invoking their getters or iterators. This is bounded data inspection, without an
arbitrary JavaScript termination guarantee or authenticated recording format.

## Results and remaining work

A review at startup can lack qualified estimator context. It returns an unfulfilled
`patrol-binding-unavailable` result without calling the ledger or requesting a flight.
There is no automatic retry. Genuine operator denial remains distinct from other refusals.

The command prints one compact JSON summary, limited to 16384 UTF-8 bytes including its newline.
It includes each decision's fulfillment, its own historical mission/contact evidence, charge
verification and measured modeled isolation, separate true and credited energy, host freshness
and actual request/acceptance counters. Optional `--output <directory>` publishes the same
summary with normalized input and a completion manifest before printing it. The directory must
not already exist. See the [recording and replay contract](patrol-recording.md) for bounds,
fresh replay consent and publication failure behavior. The command does not dump traces.

`neutral-preview`, `reviewed-denials` and `completed` exit successfully. Any unfulfilled explicit
decision, final fault or nonneutral output produces `failed` and a nonzero exit. An approved
flight must actually complete with its own verified contact; approved charging must verify and
isolate its own episode. A queued request or final relay-off value alone cannot establish success.
The retained model continues to the horizon without a fabricated final stop or revoke.

Issue #24 remains open for authenticated permissions and durable audit/consumption, restart and
concurrency outcomes, a patrol workspace, production scheduling, broader weather/recovery behavior
and physical qualification. This command adds no physical transport, unattended operation,
physical battery ratings or endurance evidence.
