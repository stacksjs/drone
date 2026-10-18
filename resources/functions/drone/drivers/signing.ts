import { createHash, timingSafeEqual } from 'node:crypto'
export interface MavlinkSigning {
  sign: (packet: Uint8Array) => Uint8Array
  verify: (packet: Uint8Array) => boolean
}
/** Key is copied, never logged. Clock is 10-microsecond ticks since 2015-01-01 UTC, not performance.now(). */
export function createMavlinkSigning(options: { key: Uint8Array, linkId: number, timestamp: () => bigint }): MavlinkSigning {
  if (!(options.key instanceof Uint8Array) || options.key.length !== 32 || !Number.isInteger(options.linkId) || options.linkId < 0 || options.linkId > 255) throw new TypeError('Signing requires a 32-byte key and byte link ID')
  const key = Uint8Array.from(options.key), linkId = options.linkId, timestamp = options.timestamp
  const incoming = new Map<string, bigint>()
  let lastClock: bigint | null = null, outgoing = -1n, failed = false
  function clock() {
    const now = timestamp()
    if (typeof now !== 'bigint' || now < 0n || now > 0xFFFFFFFFFFFFn || (lastClock !== null && now < lastClock)) failed = true
    if (failed) throw new Error('Signing clock invalid or reversed')
    lastClock = now
    return now
  }
  const digest = (bytes: Uint8Array) => createHash('sha256').update(key).update(bytes).digest().subarray(0, 6)
  return {
    sign(packet) {
      const now = clock(); outgoing = now > outgoing ? now : outgoing + 1n
      if (outgoing > 0xFFFFFFFFFFFFn) throw new Error('Signing timestamp exhausted')
      const signed = new Uint8Array(packet.length + 13)
      signed.set(packet); signed[packet.length] = linkId
      for (let i = 0; i < 6; i++) signed[packet.length + 1 + i] = Number((outgoing >> BigInt(i * 8)) & 255n)
      signed.set(digest(signed.subarray(0, -6)), signed.length - 6)
      return signed
    },
    verify(packet) {
      try {
        const now = clock()
        if (packet[0] !== 0xFD || packet[2] !== 1 || packet.length !== 10 + packet[1]! + 2 + 13) return false
        const signature = packet.length - 13
        let at = 0n
        for (let i = 0; i < 6; i++) at |= BigInt(packet[signature + 1 + i]!) << BigInt(i * 8)
        const stream = `${packet[5]}:${packet[6]}:${packet[signature]}`
        const previous = incoming.get(stream)
        if (at < now - 6000000n || at > now + 6000000n || (previous !== undefined && at <= previous) || (previous === undefined && incoming.size >= 16)) return false
        if (!timingSafeEqual(digest(packet.subarray(0, -6)), packet.subarray(-6))) return false
        incoming.set(stream, at)
        return true
      }
      catch { return false }
    },
  }
}
