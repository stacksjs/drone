import { authorityPolicy } from '../authority/supervisor'

export interface VehicleLinkScope { vehicleId: string, bootId: number, sessionId: number }
export type VehicleLinkSource = 'primary' | 'backup'
interface Packet extends VehicleLinkScope { sourceId: VehicleLinkSource, sequence: number, capturedAtMs: number, receivedAtMs: number, clockUncertaintyMs: number, connected: boolean }
const fields = ['vehicleId', 'bootId', 'sessionId', 'sourceId', 'sequence', 'capturedAtMs', 'receivedAtMs', 'clockUncertaintyMs', 'connected']
function captureData(input: unknown, keys: string[]): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length) return null
  const captured: Record<string, unknown> = {}
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(input, key)
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return null
    captured[key] = d.value
  }
  return captured
}

/** Two captured sources for one authority owner. Scope labels are not authentication. */
export function createRedundantVehicleLinks(input: VehicleLinkScope) {
  const data = captureData(input, ['vehicleId', 'bootId', 'sessionId'])
  if (!data || typeof data.vehicleId !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(data.vehicleId) || typeof data.bootId !== 'number' || !Number.isSafeInteger(data.bootId) || data.bootId < 1 || typeof data.sessionId !== 'number' || !Number.isSafeInteger(data.sessionId) || data.sessionId < 1) throw new TypeError('Invalid vehicle link scope')
  const scope = { vehicleId: data.vehicleId, bootId: data.bootId, sessionId: data.sessionId }, packets = new Map<VehicleLinkSource, Packet>()
  let lastNow = -1, seenHealthy = false, latchedLoss = false
  function clock(nowMs: number) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs < lastNow) throw new RangeError('Invalid vehicle link clock')
    lastNow = nowMs
  }
  function fresh(packet: Packet, nowMs: number) {
    return packet.connected && nowMs - packet.capturedAtMs + packet.clockUncertaintyMs <= authorityPolicy.linkAgeMs
  }
  function checkLoss(nowMs: number) {
    if (seenHealthy && ![...packets.values()].some(packet => fresh(packet, nowMs))) latchedLoss = true
  }
  return {
    ingest(input: unknown, nowMs: number): boolean {
      clock(nowMs)
      checkLoss(nowMs)
      const captured = captureData(input, fields)
      if (latchedLoss || !captured) return false
      if (captured.vehicleId !== scope.vehicleId || captured.bootId !== scope.bootId || captured.sessionId !== scope.sessionId || !['primary', 'backup'].includes(captured.sourceId as string)
        || typeof captured.connected !== 'boolean' || !['sequence', 'capturedAtMs', 'receivedAtMs', 'clockUncertaintyMs'].every(key => Number.isSafeInteger(captured[key]) && Number(captured[key]) >= 0)) return false
      const packet = captured as unknown as Packet, previous = packets.get(packet.sourceId)
      if (packet.sequence < 1 || packet.clockUncertaintyMs > 10 || packet.capturedAtMs < packet.clockUncertaintyMs || packet.capturedAtMs + packet.clockUncertaintyMs > packet.receivedAtMs || packet.receivedAtMs > nowMs
        || nowMs - packet.capturedAtMs + packet.clockUncertaintyMs > authorityPolicy.linkAgeMs || previous && (packet.sequence <= previous.sequence || packet.capturedAtMs <= previous.capturedAtMs || packet.receivedAtMs < previous.receivedAtMs)) return false
      packets.set(packet.sourceId, { ...packet })
      if (packet.connected) seenHealthy = true
      return true
    },
    snapshot(nowMs: number) {
      clock(nowMs)
      checkLoss(nowMs)
      const candidates = (['primary', 'backup'] as const).filter(id => { const packet = packets.get(id); return packet && fresh(packet, nowMs) })
      if (candidates.length) seenHealthy = true
      else if (seenHealthy) latchedLoss = true
      const selectedSource = latchedLoss ? null : candidates[0] ?? null, selected = selectedSource ? packets.get(selectedSource)! : null
      return { evidence: 'scoped-captured-link-selection' as const, scope: { ...scope }, observedAtMs: nowMs, selectedSource, latchedLoss,
        authority: { capturedAtMs: selected ? selected.capturedAtMs - selected.clockUncertaintyMs : 0, connected: selected !== null },
        sources: (['primary', 'backup'] as const).map(sourceId => { const packet = packets.get(sourceId); return { sourceId, sequence: packet?.sequence ?? null, capturedAtMs: packet?.capturedAtMs ?? null, receivedAtMs: packet?.receivedAtMs ?? null, clockUncertaintyMs: packet?.clockUncertaintyMs ?? null, connected: packet ? fresh(packet, nowMs) : false } }),
        identityAuthenticated: false as const, physicalFlightEnabled: false as const }
    },
  }
}
