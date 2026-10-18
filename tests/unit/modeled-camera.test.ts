import { expect, test } from 'bun:test'
import { createModeledCamera } from '../../resources/functions/drone/payloads/modeled-camera'
import { createRigidBody } from '../../resources/functions/drone/controls/physics'

test('modeled shutter scopes one detached frame to one monotonic request and cancels on close', () => {
  const frame = { rgba: new Uint8Array([1, 2, 3, 255]), thermalCentiKelvin: new Uint16Array([29500]) }
  const camera = createModeledCamera(() => frame)
  camera.render(createRigidBody().snapshot(), 100)
  camera.request({ sessionId: 'visit-a', sequence: 1, issuedAtMs: 100, reference: 'origin-a' })
  frame.rgba[0] = 9
  expect(() => camera.request({ sessionId: 'visit-a', sequence: 2, issuedAtMs: 100, reference: 'origin-a' })).toThrow()
  expect(camera.poll(119)).toBeNull()
  const ack = camera.poll(120)!
  expect(ack.rgba[0]).toBe(1)
  expect(ack.thermalCentiKelvin![0]).toBe(29500)
  expect(ack.sessionId).toBe('visit-a')
  expect(() => camera.request({ sessionId: 'visit-b', sequence: 2, issuedAtMs: 100, reference: 'origin-a' })).toThrow()
  camera.render(createRigidBody().snapshot(), 140)
  camera.request({ sessionId: 'visit-a', sequence: 2, issuedAtMs: 140, reference: 'origin-a' })
  camera.close()
  expect(camera.poll(200)).toBeNull()
  expect(() => camera.request({ sessionId: 'visit-a', sequence: 3, issuedAtMs: 140, reference: 'origin-a' })).toThrow()
})

test('modeled shutter rejects malformed frames and clocks, and exposes uncertainty without retry', () => {
  const body = createRigidBody().snapshot()
  const invalid = createModeledCamera(() => ({ rgba: new Uint8Array(8), thermalCentiKelvin: new Uint16Array(1) }))
  invalid.render(body, 100)
  expect(() => invalid.request({ sessionId: 'a', sequence: 1, issuedAtMs: 100, reference: 'b' })).toThrow('raster')
  const lost = createModeledCamera(() => ({ rgba: new Uint8Array(4), thermalCentiKelvin: null }), { fault: 'loss', faultAfterMs: 0 })
  lost.render(body, 100)
  lost.request({ sessionId: 'a', sequence: 1, issuedAtMs: 100, reference: 'b' })
  expect(lost.poll(180)).toBeNull()
  expect(() => lost.poll(179)).toThrow('clock')
  expect(() => lost.render(body, 99)).toThrow('clock')
  expect(() => lost.request({ sessionId: 'a', sequence: 2, issuedAtMs: 100, reference: 'b' })).toThrow()
  lost.close()
  expect(lost.poll(2200)).toBeNull()
  const wrong = createModeledCamera(() => ({ rgba: new Uint8Array(4), thermalCentiKelvin: null }), { fault: 'wrong-ack', faultAfterMs: 0 })
  wrong.render(body, 100)
  wrong.request({ sessionId: 'a', sequence: 1, issuedAtMs: 100, reference: 'b' })
  expect(wrong.poll(120)!.reference).toBe('wrong-reference')
})

import { simulateMission } from '../../resources/functions/drone/missions/simulation'
test('mission disturbance instruments apply real wind forces while the default fixture remains unchanged', () => {
  const nominal = simulateMission({ seconds: 8 })
  const wind = simulateMission({ seconds: 8, instrument: { disturbance: () => ({ windMps: [0, 0.3, 0] }), render() {}, observe() { return undefined } } })
  expect(nominal.mission.state).toBe('running')
  expect(wind.mission.state).toBe('running')
  expect(Math.abs(wind.finalTruthPositionM[1] - nominal.finalTruthPositionM[1])).toBeGreaterThan(0.01)
  expect(wind.board.motorsN).toEqual([0, 0, 0, 0])
  expect(nominal.path).toEqual(simulateMission({ seconds: 8 }).path)
})
