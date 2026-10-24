import { expect, test } from 'bun:test'
import type { AuthorityAction, AuthorityCommand, AuthorityObservation, AuthorityState } from '../../resources/functions/drone/authority/supervisor'
import { authorityStates } from '../../resources/functions/drone/authority/supervisor'
import { createSimulatedOutputWatchdog } from '../../resources/functions/drone/authority/watchdog'
import { command, engaged, observation, output, supervisor } from '../fixtures/authority/context'

function inState(state: AuthorityState) {
  const s = supervisor()
  if (state === 'disarmed') return s
  s.update(observation(), command(s, 'arm'))
  if (state === 'armed-idle') return s
  s.update(observation(), command(s, 'engage'))
  const o = observation()
  if (state === 'manual') o.rc.override = true
  if (state === 'failsafe') o.battery.remainingPercent = 20
  if (state === 'killed') o.interlocks.killActive = true
  s.update(o)
  return s
}
test('version 1 checks every state/action pair, with explicit arming and engagement', () => {
  for (const state of authorityStates) {
    for (const action of ['arm', 'engage', 'renew', 'disarm', 'reset', 'kill'] as AuthorityAction[]) {
      const s = inState(state), o = observation()
      expect(s.snapshot().state).toBe(state)
      if (action === 'reset') o.rc.armSwitch = false
      // RC disarm is an independent transition for armed states, so test their illegal reset with the switch still armed.
      if (action === 'reset' && ['armed-idle', 'autonomous', 'manual'].includes(state)) o.rc.armSwitch = true
      const result = s.update(o, command(s, action))
      const expected: Record<AuthorityState, Partial<Record<AuthorityAction, AuthorityState>>> = {
        'disarmed': { arm: 'armed-idle', disarm: 'disarmed', kill: 'killed' },
        'armed-idle': { engage: 'autonomous', disarm: 'disarmed', kill: 'killed' },
        'autonomous': { renew: 'autonomous', disarm: 'disarmed', kill: 'killed' },
        'manual': { disarm: 'disarmed', kill: 'killed' },
        'failsafe': { reset: 'disarmed', kill: 'killed' },
        'killed': { reset: 'disarmed', kill: 'killed' },
      }
      const next = expected[state][action]
      expect(result.commandAccepted).toBe(next !== undefined)
      expect(result.state).toBe(next ?? state)
      expect(result.version).toBe(1)
    }
  }
})
test('scope, replay, epoch, future/stale clocks and invalid targets revoke active authority', () => {
  const changes: ((c: AuthorityCommand) => void)[] = [
    c => { c.version = 2 as 1 }, c => { c.sessionId++ }, c => { c.bootId++ }, c => { c.epoch-- }, c => { c.sequence-- }, c => { c.sequence = NaN }, c => { c.issuedAtMs++ }, c => { c.issuedAtMs -= 101 }, c => { c.leaseMs = 101 }, c => { c.leaseMs = NaN }, c => { c.target!.positionM[0] = 21 }, c => { c.target!.yawRad = NaN }, c => { c.mode = 'rate' as 'position' },
  ]
  for (const change of changes) {
    const s = engaged(), c = command(s, 'renew'); change(c)
    expect(s.update(observation(), c).state).toBe('failsafe')
    expect(s.gate(output(), 1000)).toBeNull()
    expect(s.update(observation(1020), command(s, 'renew', 1020)).state).toBe('failsafe')
  }
})
test('leases use issuance time, expire at the boundary and cannot be resurrected by late renewal', () => {
  const s = engaged()
  for (const at of [1020, 1040, 1060, 1080]) s.update(observation(at))
  const delayed = command(s, 'renew', 1020)
  expect(s.update(observation(1080), delayed).leaseUntilMs).toBe(1120)
  s.update(observation(1100))
  expect(s.update(observation(1120), command(s, 'renew', 1120)).state).toBe('failsafe')
})
test('all independent health inputs revoke, latch and prevent automatic recovery', () => {
  const changes: ((o: AuthorityObservation) => void)[] = [
    o => { o.runtime.bootId++ }, o => { o.runtime.watchdogHealthy = false }, o => { o.runtime.capturedAtMs -= 21 },
    o => { o.rc.connected = false }, o => { o.rc.capturedAtMs -= 101 }, o => { o.link.connected = false }, o => { o.link.capturedAtMs -= 151 },
    o => { o.battery.remainingPercent = 25 }, o => { o.battery.remainingPercent = NaN }, o => { o.battery.capturedAtMs -= 501 },
    o => { o.interlocks.capturedAtMs -= 21 }, o => { o.estimate.health.tilt = false }, o => { o.estimate.health.localPosition = false },
    o => { o.estimate.nowMs-- }, o => { o.estimate.attitude!.capturedAtMs! -= 61 }, o => { o.estimate.localPosition!.positionM[0] = 21 },
    o => { o.estimate.resets.attitude++ }, o => { o.estimate.localPosition!.origin!.ellipsoidHeightM++ },
  ]
  for (const change of changes) {
    const s = engaged(), o = observation(1020); change(o)
    expect(s.update(o).state).toBe('failsafe')
    expect(s.update(observation(1040)).state).toBe('failsafe')
    const reset = observation(1040); reset.rc.armSwitch = false
    expect(s.update(reset, command(s, 'reset', 1040)).state).toBe('disarmed')
    expect(s.gate(output(1040), 1040)).toBeNull()
  }
})
test('arming and recovery require healthy fresh observations, ground and stopped motors', () => {
  for (const change of [
    (o: AuthorityObservation) => { o.interlocks.onGround = false },
    (o: AuthorityObservation) => { o.interlocks.motorsStopped = false },
    (o: AuthorityObservation) => { o.rc.override = true },
    (o: AuthorityObservation) => { o.battery.remainingPercent = 20 },
  ]) {
    const s = supervisor(), o = observation(); change(o)
    expect(s.update(o, command(s, 'arm')).state).toBe('disarmed')
    const f = inState('failsafe'), r = observation(); r.rc.armSwitch = false; change(r)
    expect(f.update(r, command(f, 'reset')).state).toBe('failsafe')
  }
})
test('kill wins over invalid time, cannot be cleared by release or disarm and needs explicit ground reset', () => {
  const s = engaged(), kill = observation(NaN); kill.interlocks.killActive = true
  expect(s.update(kill).state).toBe('killed')
  expect(s.update(observation()).state).toBe('killed')
  expect(s.update(observation(), command(s, 'disarm')).state).toBe('killed')
  const reset = observation(); reset.rc.armSwitch = false; reset.interlocks.motorsStopped = false
  expect(s.update(reset, command(s, 'reset')).state).toBe('killed')
  reset.interlocks.motorsStopped = true
  expect(s.update(reset, command(s, 'reset')).state).toBe('disarmed')
})

test('a kill event records its valid observation time and retains the prior epoch for invalid clocks', () => {
  for (const nowMs of [1020, NaN, 999]) {
    const s = engaged(), kill = observation(nowMs)
    kill.interlocks.killActive = true
    const result = s.update(kill)
    expect(result.state).toBe('killed')
    expect(result.events.at(-1)!.reason).toBe('kill-input')
    expect(result.events.at(-1)!.atMs).toBe(nowMs === 1020 ? 1020 : 1000)
    expect(result.lastCheckedAtMs).toBe(nowMs === 1020 ? 1020 : 1000)
    expect(s.gate(output(1020), 1020)).toBeNull()
  }
})
test('RC override revokes autonomous outputs and stays manual after override is released', () => {
  const s = engaged(), o = observation(1020); o.rc.override = true
  expect(s.update(o).state).toBe('manual')
  expect(s.gate(output(1020), 1020)).toBeNull()
  expect(s.update(observation(1040), command(s, 'engage', 1040)).state).toBe('manual')
  o.nowMs = 1040; const disarm = observation(1040); disarm.rc.armSwitch = false
  expect(s.update(disarm).state).toBe('disarmed')
})
test('backwards clocks and missed supervisor schedules fail closed', () => {
  for (const at of [999, 1041, Infinity]) expect(engaged().update(observation(at)).state).toBe('failsafe')
})
test('gates reject old outputs and duplicate use, copy data and expose no mutable authority state', () => {
  const s = engaged(), stale = output(980)
  expect(s.gate(stale, 1000)).toBeNull()
  expect(s.snapshot().state).toBe('failsafe')
  const t = engaged(), out = output(), frame = t.gate(out, 1000)!
  expect(frame.motorsN).toEqual([0.8, 0.8, 0.8, 0.8])
  out.motorsN[0] = 9; expect(frame.motorsN[0]).toBe(0.8)
  const snap = t.snapshot(); snap.target!.positionM[0] = 19; snap.events.length = 0
  expect(t.snapshot().target!.positionM[0]).toBe(0)
  expect(t.snapshot().events.length).toBe(2)
  expect(t.gate(output(), 1000)).toBeNull()
  expect(t.snapshot().state).toBe('failsafe')
})
const board = () => createSimulatedOutputWatchdog({ bootId: 55n, sessionId: 123n })
test('independent output watchdog expires without any further Pi command and latches', () => {
  const b = board(), frame = engaged().gate(output(), 1000)!
  expect(b.accept(frame, 1000)).toBe(true)
  frame.motorsN[0] = 9
  expect(b.tick(1059).motorsN[0]).toBe(0.8)
  expect(b.tick(1060).motorsN).toEqual([0, 0, 0, 0])
  expect(b.snapshot().fault).toBe('output-lease-expired')
  const newer = engaged().gate(output(1020), 1020) // no authority observation at 1020, so no frame
  expect(newer).toBeNull()
  expect(b.accept({ ...frame, sequence: 2, issuedAtMs: 1060, expiresAtMs: 1120 }, 1060)).toBe(false)
})
test('board rejects replay, old boot, invalid frames, excessive leases and clock rollback', () => {
  const frame = engaged().gate(output(), 1000)!
  for (const change of [
    (f: typeof frame) => { f.bootId++ }, (f: typeof frame) => { f.sessionId++ }, (f: typeof frame) => { f.motorsN[0] = NaN },
    (f: typeof frame) => { f.expiresAtMs = 1061 }, (f: typeof frame) => { f.issuedAtMs = 999 }, (f: typeof frame) => { f.epoch = -1 },
  ]) {
    const b = board(), f = structuredClone(frame); change(f)
    expect(b.accept(f, 1000)).toBe(false); expect(b.snapshot().motorsN).toEqual([0, 0, 0, 0])
  }
  const b = board(); b.accept(frame, 1000)
  expect(b.accept(frame, 1000)).toBe(false)
  b.reboot(56n); expect(b.snapshot().motorsN).toEqual([0, 0, 0, 0]); expect(b.accept(frame, 1000)).toBe(false)
  const c = board(); c.accept(frame, 1000); expect(c.tick(999).fault).toBe('board-clock-discontinuity')
})

import { authorityScenarios } from '../../resources/functions/drone/authority/harness'
import { simulateMultirotor } from '../../resources/functions/drone/controls/simulation'
test('supervised physics stabilizes nominal control and every injected hazard revokes modeled thrust', () => {
  for (const scenario of authorityScenarios) {
    const run = simulateMultirotor({ authorityScenario: scenario, seconds: scenario === 'nominal' ? 20 : 8 }), a = run.authority!
    expect(run.metrics.active).toBe(true)
    expect(a.hardwareInLoop).toBe(false)
    expect(run.physicalFlightEnabled).toBe(false)
    if (scenario === 'nominal') {
      expect(run.metrics.finalPositionErrorM).toBeLessThan(0.05)
      expect(run.metrics.groundContacts).toBe(0)
      expect(a.supervisor.state).toBe('autonomous')
      expect(a.firstZeroMs).toBeNull()
      continue
    }
    expect(a.firstZeroMs).toBeGreaterThanOrEqual(3000)
    expect(a.firstZeroMs!).toBeLessThanOrEqual(3100)
    expect(a.board.motorsN).toEqual([0, 0, 0, 0])
    expect(run.trace.filter(row => row.atMs >= 3200).every(row => row.motorsN.every(n => n === 0))).toBe(true)
    if (scenario === 'pi-loss') {
      expect(a.hostAlive).toBe(false)
      expect(a.lastHostCheckMs).toBe(2996)
      expect(a.firstRevocationMs).toBeNull() // No fiction that a dead host executed a failsafe.
      expect(a.board.fault).toBe('output-lease-expired')
      expect(a.firstZeroMs).toBe(3040)
      expect(a.supervisor.lastCheckedAtMs).toBe(2996)
      expect(run.estimate.nowMs).toBe(2996)
      expect(run.control!.atMs).toBe(2980)
    }
    else {
      expect(a.firstRevocationMs).toBe(a.firstZeroMs)
      if (scenario === 'rc-override') expect(a.supervisor.events.some(e => e.to === 'manual' && e.atMs === 3000)).toBe(true)
      expect(a.supervisor.state).toBe(scenario === 'kill' ? 'killed' : scenario === 'disarm' ? 'disarmed' : 'failsafe')
    }
  }
}, 180000)

import { command as cliCommand } from '@stacksjs/testing'
test('native Stacks authority command runs fault injection and rejects unknown scenarios/durations', async () => {
  const result = await cliCommand(['authority:simulate', '--scenario', 'pi-loss', '--seconds', '4']).withTimeout(60000)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout).authority.board.fault).toBe('output-lease-expired')
  for (const args of [['--scenario', 'actual-flight'], ['--seconds', '3']]) {
    expect((await cliCommand(['authority:simulate', ...args]).withTimeout(60000)).exitCode).toBe(1)
  }
}, 180000)


test('independent override/disarm/kill/fault transitions take priority over pending commands', () => {
  for (const scenario of ['override', 'disarm', 'kill', 'estimator'] as const) {
    const s = engaged(), pending = command(s, 'renew', 1020), o = observation(1020)
    if (scenario === 'override') o.rc.override = true
    if (scenario === 'disarm') o.rc.armSwitch = false
    if (scenario === 'kill') o.interlocks.killActive = true
    if (scenario === 'estimator') o.estimate.health.tilt = false
    const result = s.update(o, pending)
    expect(result.state).toBe(scenario === 'override' ? 'manual' : scenario === 'disarm' ? 'disarmed' : scenario === 'kill' ? 'killed' : 'failsafe')
    expect(result.commandAccepted).toBe(false)
    expect(result.events.at(-1)!.reason).toBe(scenario === 'override' ? 'rc-override' : scenario === 'disarm' ? 'rc-disarm' : scenario === 'kill' ? 'kill-input' : 'estimator-loss')
    expect(s.gate(output(1020), 1020)).toBeNull()
  }
})


test('disarm and rearm cannot gate the same feedback twice at a single timestamp', () => {
  const s = engaged(), oldOutput = output()
  expect(s.gate(oldOutput, 1000)).not.toBeNull()
  for (const action of ['disarm', 'arm', 'engage'] as const) expect(s.update(observation(), command(s, action)).commandAccepted).toBe(true)
  expect(s.gate(oldOutput, 1000)).toBeNull()
  expect(s.snapshot().state).toBe('failsafe')
})
