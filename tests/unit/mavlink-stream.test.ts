import { expect, test } from 'bun:test'
import fixtures from '../fixtures/mavlink.json'
import vectors from '../fixtures/drivers/wire.json'
import { createMavlinkStreamDecoder } from '../../resources/functions/drone/mavlink'
import { createMavlinkSigning } from '../../resources/functions/drone/drivers/signing'

test('a stream reconstructs independent v1 and v2 wire fixtures across every split', () => {
  const packets = [fixtures.v1Heartbeat, fixtures.v2Heartbeat].map(hex => Buffer.from(hex, 'hex'))
  for (const packet of packets) {
    for (let split = 0; split <= packet.length; split++) {
      const decoder = createMavlinkStreamDecoder()
      const frames = [...decoder.push(packet.subarray(0, split)), ...decoder.push(packet.subarray(split))]
      expect(frames).toHaveLength(1)
      expect(frames[0]!.id).toBe(0)
      expect(frames[0]!.systemId).toBe(1)
      expect(decoder.retainedBytes).toBe(0)
    }
  }
})

test('a bounded stream resynchronizes noise and damaged length or CRC without trusting them', () => {
  const valid = Buffer.from(fixtures.v2Heartbeat, 'hex')
  for (const field of [1, valid.length - 1]) {
    const damaged = Buffer.from(valid); damaged[field] = field === 1 ? 255 : damaged[field]! ^ 1
    const decoder = createMavlinkStreamDecoder()
    const bytes = Buffer.concat([Buffer.from([7, 0, 8]), damaged, valid, Buffer.alloc(280)])
    expect(decoder.push(bytes).map(frame => frame.id)).toEqual([0])
    expect(decoder.retainedBytes).toBe(0)
  }
  const decoder = createMavlinkStreamDecoder()
  expect(decoder.push(Buffer.alloc(65_536, 0xFD))).toEqual([])
  expect(decoder.retainedBytes).toBeLessThan(280)
  expect(() => decoder.push(Buffer.alloc(65_537))).toThrow('65536')
  decoder.reset()
  expect(decoder.retainedBytes).toBe(0)
  expect(decoder.push(valid)).toHaveLength(1)
})

test('fragmented signed wire vectors verify once, reject replay, tamper and unsigned downgrade', () => {
  const signed = Buffer.from(vectors.packets.signedHeartbeat, 'hex')
  for (let split = 0; split <= signed.length; split++) {
    const signing = createMavlinkSigning({ key: Uint8Array.from({ length: 32 }, (_, i) => i), linkId: 7, timestamp: () => 1000000n })
    const decoder = createMavlinkStreamDecoder(signing)
    expect([...decoder.push(signed.subarray(0, split)), ...decoder.push(signed.subarray(split))]).toHaveLength(1)
    expect(decoder.push(signed)).toEqual([])
    const altered = Buffer.from(signed); altered[altered.length - 1]! ^= 1
    expect(decoder.push(altered)).toEqual([])
    expect(decoder.push(Buffer.from(fixtures.v2Heartbeat, 'hex'))).toEqual([])
    decoder.reset() // Framing reset must not reset authenticated replay watermarks.
    expect(decoder.push(signed)).toEqual([])
  }
})
