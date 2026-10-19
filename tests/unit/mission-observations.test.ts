import { expect, test } from 'bun:test'
import { simulateMission } from '../../resources/functions/drone/missions/simulation'
import type { MissionSimulationObservation } from '../../resources/functions/drone/missions/simulation'

// Public function seam: actual owned supervisor, engine and board outputs, without physical flight evidence.
test('observed control-link loss reaches actual authority and neutral board at the same epoch', () => {
  let actualAuthority = '', actualConnected = true
  const run = simulateMission({ instrument: {
    observation(nowMs) { return { link: { capturedAtMs: nowMs, connected: nowMs < 5000 } } },
    render() {},
    observe(context) {
      if (context.nowMs === 5000) { actualAuthority = context.authority; actualConnected = context.link.connected }
      return undefined
    },
  } })
  expect(run.trace.rows.at(-1)!.observation.nowMs).toBe(5000)
  expect(run.mission.state).toBe('blocked')
  expect(actualAuthority).toBe('failsafe')
  expect(actualConnected).toBe(false)
  expect(run.authority.state).toBe('failsafe')
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
})

test('resource updates enter the real mission input and retained callback snapshots cannot mutate controls', () => {
  let observedBattery = 100
  const run = simulateMission({ instrument: {
    observation(nowMs) { return { battery: { capturedAtMs: nowMs, remainingPercent: nowMs < 5000 ? 80 : 20 } } },
    render() {},
    observe(context) {
      if (context.nowMs === 5000) observedBattery = context.battery.remainingPercent
      context.battery.remainingPercent = 100
      context.link.connected = false
      context.estimate.health.localPosition = false
      return undefined
    },
  } })
  expect(run.trace.rows[0]!.observation.batteryPercent).toBe(80)
  expect(run.trace.rows.at(-1)!.observation.batteryPercent).toBe(20)
  expect(run.trace.rows.at(-1)!.observation.nowMs).toBe(5000)
  expect(observedBattery).toBe(20)
  expect(run.authority.state).toBe('failsafe')
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
})

test('invalid, stale, replayed and future fixture observations abort before new outputs', () => {
  const invalid: ((nowMs: number) => MissionSimulationObservation)[] = [
    nowMs => ({ link: { capturedAtMs: nowMs - 151, connected: true } }),
    nowMs => ({ battery: { capturedAtMs: nowMs - 501, remainingPercent: 70 } }),
    nowMs => ({ link: { capturedAtMs: nowMs + 1, connected: true } }),
    nowMs => ({ battery: { capturedAtMs: nowMs, remainingPercent: 100 } }),
    () => { throw new Error('fixture failure') },
    () => undefined as unknown as MissionSimulationObservation,
    () => ({ link: { capturedAtMs: 4000, connected: true } }),
    nowMs => ({ link: { capturedAtMs: nowMs === 5000 ? 4980 : nowMs, connected: nowMs !== 5000 } }),
    nowMs => ({ link: { capturedAtMs: nowMs === 5000 ? 4960 : nowMs, connected: true } }),
  ]
  for (const invalidAtFault of invalid) {
    const run = simulateMission({ instrument: {
      observation(nowMs) { return nowMs < 5000 ? { link: { capturedAtMs: nowMs, connected: true } } : invalidAtFault(nowMs) },
      render() {}, observe() { return undefined },
    } })
    expect(run.mission.state).toBe('blocked')
    expect(run.trace.rows.at(-1)!.observation.nowMs).toBe(5000)
    expect(run.board.motorsN).toEqual([0, 0, 0, 0])
    expect(run.authority.state).toBe('failsafe')
  }
  let getterRead = false
  const sample = Object.defineProperty({}, 'link', { enumerable: true, get() { getterRead = true; return { capturedAtMs: 5000, connected: true } } })
  const run = simulateMission({ instrument: { observation() { return sample }, render() {}, observe() { return undefined } } })
  expect(getterRead).toBe(false)
  expect(run.mission.state).toBe('aborted')
})

test('an omitted observation cannot erase an earlier resource constraint or refresh its age', () => {
  const seen: { atMs: number, battery: number }[] = []
  const run = simulateMission({ instrument: {
    observation(nowMs) { return nowMs === 600 ? { battery: { capturedAtMs: nowMs, remainingPercent: 80 } } : {} },
    render() {}, observe(context) { seen.push({ atMs: context.nowMs, battery: context.battery.remainingPercent }); return undefined },
  } })
  expect(seen.find(row => row.atMs === 620)!.battery).toBe(80)
  expect(run.trace.rows.at(-1)!.observation.nowMs).toBe(1120)
  expect(run.mission.state).toBe('blocked')
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
})

test('instrument cancellation and callback failure take priority over scripted pause and recovery', () => {
  for (const scenario of ['pause-resume', 'recovery'] as const) {
    for (const failure of ['abort', 'throw', 'malformed'] as const) {
      const run = simulateMission({ scenario, instrument: {
        render() {},
        observe(context) {
          if (context.nowMs !== 5000) return undefined
          if (failure === 'throw') throw new Error('policy failure')
          return failure === 'malformed' ? 'resume' as 'abort' : 'abort'
        },
      } })
      expect(run.mission.state).toBe('aborted')
      expect(run.trace.rows.at(-1)!.observation.nowMs).toBe(5000)
      expect(run.board.motorsN).toEqual([0, 0, 0, 0])
      expect(run.recovered).toBe(false)
    }
  }
})
