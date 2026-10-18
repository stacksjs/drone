import { expect, test } from 'bun:test'
import { simulateInspection } from '../../resources/functions/drone/inspection/runtime'
import { replayMission } from '../../resources/functions/drone/missions/engine'

test('asset stations execute on the owned sensor estimator authority mission and board pipeline', () => {
  const run = simulateInspection()
  expect(run.status).toBe('completed')
  expect(run.captures).toHaveLength(3)
  expect(run.boardNeutral).toBe(true)
  expect(replayMission(run.trace).snapshot().state).toBe('completed')
  expect(run.minimumObservedSeparationM).toBeGreaterThan(1)
  expect(new Set(run.captures.map(frame => Array.from(frame.image.rgba).join(','))).size).toBe(3)
  for (const capture of run.captures) {
    expect(capture.quality.qualified).toBe(true)
    expect(capture.pose.reference).toBe(capture.assetObservation.reference)
    expect(capture.acknowledgedAtMs).toBe(capture.capturedAtMs + 20)
    expect(capture.image.thermalCentiKelvin.some(n => n > 0)).toBe(true)
  }
})

test('actual wind changes the path and rendered images while repeatable visits remain controlled', () => {
  const nominal = simulateInspection({ visitId: 'before' }), wind = simulateInspection({ scenario: 'wind', visitId: 'after' })
  expect(wind.status).toBe('completed')
  expect(wind.captures).toHaveLength(3)
  expect(wind.boardNeutral).toBe(true)
  expect(wind.path).not.toEqual(nominal.path)
  expect(wind.captures[0]!.image.rgba).not.toEqual(nominal.captures[0]!.image.rgba)
  expect(wind.minimumObservedSeparationM).toBeGreaterThan(1.5)
  expect(wind.captures.every(c => c.quality.qualified)).toBe(true)
})

test('fresh sensor loss, transient asset motion and ambiguous shutters latch terminal neutral outcomes', () => {
  const expected = { 'gnss-loss': ['blocked', 'inspection-authority-lost'], 'structure-motion': ['aborted', 'inspection-asset-moved'], 'camera-loss': ['aborted', 'inspection-camera-ack-deadline'], 'wrong-ack': ['aborted', 'inspection-camera-ack-scope-or-timing'] } as const
  for (const scenario of Object.keys(expected) as (keyof typeof expected)[]) {
    const run = simulateInspection({ scenario })
    expect([run.status, run.reason]).toEqual([...expected[scenario]])
    expect(run.captures).toHaveLength(0)
    expect(run.boardNeutral).toBe(true)
    expect(run.trace.rows.at(-1)!.result.targetM).toBeNull()
    expect(run.trace.rows.at(-1)!.observation.nowMs).toBeLessThan(12000)
  }
})

test('operator pause resumes only explicitly while abort and RC authority revoke collection', () => {
  const paused = simulateInspection({ scenario: 'pause-resume' })
  expect(paused.status).toBe('completed')
  expect(paused.captures).toHaveLength(3)
  expect(paused.trace.rows.find(row => row.observation.nowMs === 5000)!.result.state).toBe('paused')
  expect(paused.trace.rows.find(row => row.observation.nowMs === 7000)!.action).toBe('resume')
  expect(paused.captures.every(capture => capture.capturedAtMs < 5000 || capture.capturedAtMs > 7000)).toBe(true)
  for (const scenario of ['abort', 'rc-override'] as const) {
    const run = simulateInspection({ scenario })
    expect(run.status).toBe(scenario === 'abort' ? 'aborted' : 'blocked')
    expect(run.boardNeutral).toBe(true)
    expect(run.captures).toHaveLength(0)
    expect(run.trace.rows.at(-1)!.observation.nowMs).toBe(5000)
  }
})

test('bounded partial collection and repeated sessions cannot share pending captures or mutable state', () => {
  const partial = simulateInspection({ seconds: 8 })
  expect(partial.status).toBe('incomplete')
  expect(partial.captures).toHaveLength(0)
  expect(partial.boardNeutral).toBe(true)
  const a = simulateInspection({ visitId: 'session-a' }), b = simulateInspection({ visitId: 'session-b' })
  expect(a.captures[0]!.sessionId).not.toBe(b.captures[0]!.sessionId)
  const byte = b.captures[0]!.image.rgba[0]
  a.captures[0]!.image.rgba[0] = 123
  expect(b.captures[0]!.image.rgba[0]).toBe(byte)
  expect(a.path).toEqual(b.path)
  expect(() => simulateInspection({ visitId: '../other' })).toThrow()
  expect(() => simulateInspection({ seconds: 7 })).toThrow()
})
