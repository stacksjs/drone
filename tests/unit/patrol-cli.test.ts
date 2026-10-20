import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('native patrol command defaults to one bounded neutral JSON summary with no decisions or authority', async () => {
  const run = await command(['patrol:simulate']).withTimeout(60000)
  expect(run.exitCode).toBe(0)
  const result = JSON.parse(run.stdout)
  expect(result.status).toBe('neutral-preview')
  expect(result.counts.flightRequests).toBe(0)
  expect(result.counts.chargeRequests).toBe(0)
  expect(result.counts.armsAccepted).toBe(0)
  expect(result.counts.chargeFramesAccepted).toBe(0)
  expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(16384)
}, 70000)

test('native flags reject false strings and invalid combinations before opening a file or running the experiment', async () => {
  for (const args of [
    ['--profile', 'physical'], ['--unsigned-local-review'], ['--enable-charge'], ['--decisions', '/private-patrol-sentinel'],
    ['--unsigned-local-review=false'], ['--enable-charge=false'],
    ['--unsigned-local-review=false', '--decisions', '/private-patrol-sentinel'], ['--unknown-patrol-flag'], ['--decisions'], ['--profile'],
  ]) {
    const result = await command(['patrol:simulate', ...args]).withTimeout(60000)
    // The installed native parser owns usage errors (exit 2); handler failures are exit 1.
    if (['--unknown-patrol-flag', '--decisions', '--profile'].includes(args[0]!) && args.length === 1) expect(result.exitCode).not.toBe(0)
    else expect(result.exitCode).toBe(1)
    expect(result.stdout).not.toContain('owned-patrol-simulation')
    expect(result.stderr).not.toContain('/private-patrol-sentinel')
    expect(result.timedOut).toBe(false)
  }
  const negative = await command(['patrol:simulate', '--no-unsigned-local-review', '--no-enable-charge']).withTimeout(60000)
  expect(negative.exitCode).toBe(0)
  expect(JSON.parse(negative.stdout).status).toBe('neutral-preview')
}, 70000)

test('native final Boolean normalization is explicit with an existing file while repeated value options reject', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'patrol-final-options-'))
  const path = join(directory, 'decisions.json')
  try {
    await writeFile(path, fileText([]))
    // Native merge replaces previous values when the LAST value is an actual Boolean.
    for (const [label, flags] of [
      ['repeated-bare-review', ['--unsigned-local-review', '--unsigned-local-review']],
      ['false-string-then-bare-review', ['--unsigned-local-review=false', '--unsigned-local-review']],
    ] as const) {
      const run = await command(['patrol:simulate', '--decisions', path, ...flags]).withTimeout(60000)
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ label, exitCode: run.exitCode, timedOut: run.timedOut, stdoutBytes: Buffer.byteLength(run.stdout) }))
      expect(run.exitCode).toBe(0)
      const result = JSON.parse(run.stdout)
      expect(result.status).toBe('neutral-preview')
      expect(result.counts.flightRequests).toBe(0)
      expect(result.counts.chargeRequests).toBe(0)
      expect(result.counts.armsAccepted).toBe(0)
      expect(result.counts.chargeFramesAccepted).toBe(0)
      expect(run.timedOut).toBe(false)
    }
    for (const [label, flags] of [
      ['final-string-false-review', ['--decisions', path, '--unsigned-local-review=false']],
      ['final-negative-review', ['--decisions', path, '--unsigned-local-review', '--no-unsigned-local-review']],
      ['repeated-profile-value', ['--decisions', path, '--unsigned-local-review', '--profile', 'nominal', '--profile', 'nominal']],
      ['repeated-decision-value', ['--decisions', path, '--decisions', path, '--unsigned-local-review']],
    ] as const) {
      const run = await command(['patrol:simulate', ...flags]).withTimeout(60000)
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ label, exitCode: run.exitCode, timedOut: run.timedOut, stdoutBytes: Buffer.byteLength(run.stdout) }))
      expect(run.exitCode).toBe(1)
      expect(run.stdout).toBe('')
      expect(run.stderr).not.toContain(path)
      expect(run.timedOut).toBe(false)
    }
    await writeFile(path, fileText([{ kind: 'charge', id: 'charge-denied', occurrenceId: 'patrol-slot-zero', atMs: 0, decision: 'deny' }]))
    const stringFalseCharge = await command(['patrol:simulate', '--decisions', path, '--unsigned-local-review', '--enable-charge=false']).withTimeout(60000)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ label: 'final-string-false-charge', exitCode: stringFalseCharge.exitCode, timedOut: stringFalseCharge.timedOut, stdoutBytes: Buffer.byteLength(stringFalseCharge.stdout) }))
    expect(stringFalseCharge.exitCode).toBe(1)
    expect(stringFalseCharge.stdout).toBe('')
    expect(stringFalseCharge.stderr).not.toContain(path)
    expect(stringFalseCharge.timedOut).toBe(false)
    const denied = await command(['patrol:simulate', '--decisions', path, '--unsigned-local-review', '--enable-charge', '--enable-charge']).withTimeout(60000)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ label: 'repeated-bare-charge', exitCode: denied.exitCode, timedOut: denied.timedOut, stdoutBytes: Buffer.byteLength(denied.stdout) }))
    expect(denied.exitCode).toBe(0)
    const result = JSON.parse(denied.stdout)
    expect(result.status).toBe('reviewed-denials')
    expect(result.decisions[0].reason).toBe('charge-operator-denied')
    expect(result.decisions[0].fulfilled).toBe(true)
    expect(result.counts.chargeRequests).toBe(1)
    expect(result.counts.flightRequests).toBe(0)
    expect(result.counts.armsAccepted).toBe(0)
    expect(result.counts.chargeFramesAccepted).toBe(0)
    expect(denied.timedOut).toBe(false)
    const finalNegative = await command(['patrol:simulate', '--decisions', path, '--unsigned-local-review', '--enable-charge', '--no-enable-charge']).withTimeout(60000)
    expect(finalNegative.exitCode).toBe(1)
    expect(finalNegative.stdout).toBe('')
    expect(finalNegative.stderr).not.toContain(path)
    expect(finalNegative.timedOut).toBe(false)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 70000)

test('native decision reader accepts exactly 8192 bytes but refuses oversized invalid UTF8 BOM symlink directory and FIFO input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'patrol-files-'))
  const path = join(directory, 'decisions.json')
  try {
    const empty = fileText([])
    await writeFile(path, empty.padEnd(8192, ' '))
    const accepted = await command(['patrol:simulate', '--decisions', path, '--unsigned-local-review', '--enable-charge']).withTimeout(60000)
    expect(accepted.exitCode).toBe(0)
    expect(JSON.parse(accepted.stdout).counts.chargeRequests).toBe(0)
    expect(JSON.parse(accepted.stdout).counts.armsAccepted).toBe(0)
    for (const text of [empty.padEnd(8193, ' '), new Uint8Array([255, 254]), `\uFEFF${empty}`, JSON.stringify({ version: 1, profile: 'nominal', decisions: [], privateSentinel: 'never-echo-this' }), fileText([flight(), { kind: 'charge', id: 'bad-last', atMs: 47001, decision: 'approve', occurrenceId: 'patrol-slot-zero' }])]) {
      await writeFile(path, text)
      const result = await command(['patrol:simulate', '--decisions', path, '--unsigned-local-review', '--enable-charge']).withTimeout(60000)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).not.toContain(path)
      expect(result.stderr).not.toContain('never-echo-this')
      expect(result.timedOut).toBe(false)
    }
    const link = join(directory, 'link.json')
    await symlink(path, link)
    const fifo = join(directory, 'decisions.fifo')
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
    for (const invalid of [link, directory, fifo]) {
      const result = await command(['patrol:simulate', '--decisions', invalid, '--unsigned-local-review']).withTimeout(60000)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).not.toContain(invalid)
      expect(result.timedOut).toBe(false)
    }
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 70000)

const anchor = 1767225600000
const flight = (decision = 'approve', atMs = 2000, id = 'first', dueUtcMs = anchor) => ({ kind: 'flight', id, atMs, dueUtcMs, decision })
const fileText = (decisions: unknown[]) => JSON.stringify({ version: 1, profile: 'nominal', decisions })

test('native explicit decision file fulfills only real denial or completed contact and separately opted-in charge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'patrol-native-'))
  const path = join(directory, 'decisions.json')
  try {
    await writeFile(path, fileText([flight('deny')]))
    const denied = await command(['patrol:simulate', '--decisions', path, '--unsigned-local-review']).withTimeout(60000)
    expect(denied.exitCode).toBe(0)
    expect(JSON.parse(denied.stdout).status).toBe('reviewed-denials')
    expect(JSON.parse(denied.stdout).counts.armsAccepted).toBe(0)
    await writeFile(path, fileText([flight(), { kind: 'charge', id: 'charge-first', occurrenceId: 'patrol-slot-zero', atMs: 47000, decision: 'approve' }, flight('approve', 60000, 'second', anchor + 60000)]))
    const approved = await command(['patrol:simulate', '--decisions', path, '--unsigned-local-review', '--enable-charge']).withTimeout(60000)
    expect(approved.exitCode).toBe(0)
    const result = JSON.parse(approved.stdout)
    expect(result.status).toBe('completed')
    expect(result.decisions.map((d: { fulfilled: boolean }) => d.fulfilled)).toEqual([true, true, true])
    expect(result.flights.map((f: { terminalAtMs: number }) => f.terminalAtMs)).toEqual([44120, 102120])
    expect(result.charge.episodes[0].isolatedAtMs).toBe(55400)
    expect(result.counts.chargeFramesAccepted).toBe(400)
    expect(approved.stdout.endsWith('\n')).toBe(true)
    expect(approved.stdout.trim().split('\n')).toHaveLength(1)
    expect(Buffer.byteLength(approved.stdout)).toBeLessThanOrEqual(16384)
    await writeFile(path, fileText([flight('deny', 0)]))
    const early = await command(['patrol:simulate', '--decisions', path, '--unsigned-local-review']).withTimeout(60000)
    expect(early.exitCode).toBe(1)
    expect(JSON.parse(early.stdout).decisions[0].reason).toBe('patrol-binding-unavailable')
    expect(JSON.parse(early.stdout).counts.flightReviewCalls).toBe(0)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 70000)
