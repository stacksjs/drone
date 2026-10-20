import { types as nodeTypes } from 'node:util'
import type { SensorVector } from '../sensors/types'

export interface CinemaEncoderCountTick { sequence: number, capturedAtMs: number, receivedAtMs: number, positionCounts: [number, number, number], limitSwitch: boolean }
export interface CinemaCountedEncoder { version: 1, sequence: number, capturedAtMs: number, receivedAtMs: number, positionCounts: [number, number, number], deltaCounts: [number, number, number] | null, positionRad: SensorVector, velocityRadS: SensorVector | null, limitSwitch: boolean }
export interface CinemaCountedEncoderMethod { version: 1, method: 'count-difference-v1', quantumRad: 0.001, intervalMs: 20, delayMs: 20, rateUnitRadS: 0.05, countLimit: 8000, deltaLimit: 16000, rounding: 'nearest-ties-positive' }
export const cinemaCountedEncoderMethod: Readonly<CinemaCountedEncoderMethod> = Object.freeze({ version: 1, method: 'count-difference-v1', quantumRad: 0.001, intervalMs: 20, delayMs: 20, rateUnitRadS: 0.05, countLimit: 8000, deltaLimit: 16000, rounding: 'nearest-ties-positive' })

function invalid(): never { throw new TypeError('cinema-counted-encoder-input') }
function data(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return invalid()
  const own = Reflect.ownKeys(input), descriptors = Object.getOwnPropertyDescriptors(input)
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) return invalid()
  const out: Record<string, unknown> = {}
  for (const key of keys) { const d = descriptors[key]; if (!d?.enumerable || !Object.hasOwn(d, 'value')) return invalid(); out[key] = d.value }
  return out
}
function integer(input: unknown, low: number, high: number): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < low || input > high) return invalid(); return input }
function counts(input: unknown): [number, number, number] {
  if (nodeTypes.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return invalid()
  const d = Object.getOwnPropertyDescriptors(input)
  if (Object.getOwnPropertyDescriptor(input, 'length')?.value !== 3 || Reflect.ownKeys(input).length !== 4) return invalid()
  function at(i: number): number { const v = d[String(i)]; if (!v?.enumerable || !Object.hasOwn(v, 'value')) return invalid(); const n = integer(v.value, -8000, 8000); if (Object.is(n, -0)) return invalid(); return n }
  return [at(0), at(1), at(2)]
}
function tick(input: unknown): CinemaEncoderCountTick {
  const d = data(input, ['sequence', 'capturedAtMs', 'receivedAtMs', 'positionCounts', 'limitSwitch'])
  const sequence = integer(d.sequence, 1, 2251), receivedAtMs = integer(d.receivedAtMs, 600, 45000), capturedAtMs = integer(d.capturedAtMs, 580, 44980)
  if (receivedAtMs !== 600 + 20 * (sequence - 1) || capturedAtMs !== receivedAtMs - 20 || typeof d.limitSwitch !== 'boolean') return invalid()
  return { sequence, capturedAtMs, receivedAtMs, positionCounts: counts(d.positionCounts), limitSwitch: d.limitSwitch }
}
/** Count-domain differentiation of declared fixture ticks, without a clock or plant. */
export function measureCountedCinemaEncoder(input: unknown): CinemaCountedEncoder {
  const d = data(input, ['current', 'previous']), current = tick(d.current), previous = d.previous === null ? null : tick(d.previous)
  if (current.sequence === 1 ? previous !== null : !previous || previous.sequence !== current.sequence - 1 || previous.receivedAtMs !== current.receivedAtMs - 20 || previous.capturedAtMs !== current.capturedAtMs - 20) return invalid()
  const deltaCounts: SensorVector | null = previous ? [current.positionCounts[0] - previous.positionCounts[0], current.positionCounts[1] - previous.positionCounts[1], current.positionCounts[2] - previous.positionCounts[2]] : null
  const result: CinemaCountedEncoder = { version: 1, sequence: current.sequence, capturedAtMs: current.capturedAtMs, receivedAtMs: current.receivedAtMs, positionCounts: [...current.positionCounts], deltaCounts, positionRad: [current.positionCounts[0] * 0.001, current.positionCounts[1] * 0.001, current.positionCounts[2] * 0.001], velocityRadS: deltaCounts ? [deltaCounts[0] * 0.05, deltaCounts[1] * 0.05, deltaCounts[2] * 0.05] : null, limitSwitch: current.limitSwitch }
  if (result.deltaCounts?.some(n => !Number.isSafeInteger(n) || Math.abs(n) > 16000) || result.positionRad.some(n => !Number.isFinite(n)) || result.velocityRadS?.some(n => !Number.isFinite(n)) || new TextEncoder().encode(JSON.stringify(result)).length > 512) throw new RangeError('cinema-unqualified-result')
  return result
}
