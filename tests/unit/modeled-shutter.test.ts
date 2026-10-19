import { expect, test } from 'bun:test'
import { createModeledShutter } from '../../resources/functions/drone/payloads/modeled-shutter'
import { createRigidBody } from '../../resources/functions/drone/controls/physics'

test('generic shutter acknowledges one detached domain frame with exact scope and cancels pending work', () => {
  const raw = { red: new Uint16Array([8000]), nir: new Uint16Array([12000]), irradiance: 0.5 }
  const shutter = createModeledShutter(() => raw, frame => ({ red: new Uint16Array(frame.red), nir: new Uint16Array(frame.nir), irradiance: frame.irradiance }))
  shutter.render(createRigidBody().snapshot(), 100)
  shutter.request({ sessionId: 'agriculture-one', sequence: 1, issuedAtMs: 100, reference: 'origin-one' })
  raw.red[0] = 9; raw.irradiance = 9
  expect(shutter.poll(119)).toBeNull()
  const ack = shutter.poll(120)!
  expect(ack.image.red[0]).toBe(8000)
  expect(ack.image.irradiance).toBe(0.5)
  expect(Object.keys(ack).sort()).toEqual(['acknowledgedAtMs', 'capturedAtMs', 'image', 'issuedAtMs', 'reference', 'sequence', 'sessionId'])
  expect(() => shutter.request({ sessionId: 'changed', sequence: 2, issuedAtMs: 100, reference: 'origin-one' })).toThrow()
  shutter.render(createRigidBody().snapshot(), 140)
  shutter.request({ sessionId: 'agriculture-one', sequence: 2, issuedAtMs: 140, reference: 'origin-one' })
  shutter.close()
  expect(shutter.poll(200)).toBeNull()
})

test('generic shutter preserves monotonic scope, fault outcomes and snapshot validation', () => {
  const body = createRigidBody().snapshot()
  for (const fault of ['loss', 'wrong-ack'] as const) {
    const shutter = createModeledShutter(() => new Uint16Array([123]), frame => new Uint16Array(frame), { fault, faultAfterMs: 0 })
    shutter.render(body, 100)
    shutter.request({ sessionId: 'a', sequence: 1, issuedAtMs: 100, reference: 'b' })
    const ack = shutter.poll(180)
    if (fault === 'loss') expect(ack).toBeNull()
    else expect(ack!.reference).toBe('wrong-reference')
    expect(() => shutter.poll(179)).toThrow('clock')
    expect(() => shutter.render(body, 99)).toThrow('clock')
    shutter.close()
  }
  const shutter = createModeledShutter(() => 10, () => { throw new RangeError('Invalid domain frame') })
  shutter.render(body, 100)
  expect(() => shutter.request({ sessionId: 'a', sequence: 1, issuedAtMs: 100, reference: 'b' })).toThrow('domain frame')
})
