import type { PublicSafetyConfig } from '../types'
import type { PublicSafetyEvent, PublicSafetyScenario } from '../runtime-types'
import { createHash } from 'node:crypto'
import { publicSafetyEvidenceLimits } from '../evidence'

export const executionWords = Object.freeze({ credit: 0, cancel: 1, emitted: 2, returned: 3, stage: 4, length: 5 })
export interface ExecutionWorkerInput { version: 1, config: PublicSafetyConfig, scenario: PublicSafetyScenario, seconds: number, control: SharedArrayBuffer, creditWaitMs: number }
export type ExecutionWorkerMessage =
  | { version: 1, kind: 'event', event: PublicSafetyEvent }
  | { version: 1, kind: 'result', buffer: ArrayBuffer, byteLength: number, digest: string }
  | { version: 1, kind: 'finished', outcome: 'completed' | 'canceled' | 'failed' | 'refused', transferred: boolean }

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new TypeError('Invalid execution protocol')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).length !== fields.length || fields.some(field => !descriptors[field] || !descriptors[field]!.enumerable || !('value' in descriptors[field]!))) throw new TypeError('Invalid execution protocol')
  return Object.fromEntries(fields.map(field => [field, descriptors[field]!.value]))
}
const integer = (value: unknown, minimum = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= publicSafetyEvidenceLimits.array
const identifier = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
export const executionDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/** Supplemental protocol boundary; successful shape checking never replaces native authority/replay. */
export function parseExecutionWorkerMessage(input: unknown): ExecutionWorkerMessage {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid execution protocol')
  const kind = Object.getOwnPropertyDescriptor(input, 'kind')?.value
  if (kind === 'event') {
    const message = object(input, ['version', 'kind', 'event'])
    const event = object(message.event, ['sequence', 'atMs', 'kind', 'captureId', 'observationCount', 'captureCount', 'incidentRevision'])
    if (message.version !== 1 || !integer(event.sequence, 1) || !integer(event.atMs) || !integer(event.observationCount) || !integer(event.captureCount) || !identifier(event.incidentRevision) || !['mission-observation', 'capture-confirmed', 'incident-update'].includes(event.kind as string) || (event.kind === 'capture-confirmed' ? !identifier(event.captureId) : event.captureId !== null)) throw new TypeError('Invalid execution event')
    return { version: 1, kind, event: event as unknown as PublicSafetyEvent }
  }
  if (kind === 'result') {
    const message = object(input, ['version', 'kind', 'buffer', 'byteLength', 'digest'])
    // The intrinsic brand check rejects SharedArrayBuffer even with a replaced prototype.
    let length: number
    try { length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(message.buffer) as number }
    catch { throw new TypeError('Invalid execution result buffer') }
    if (message.version !== 1 || !Number.isSafeInteger(message.byteLength) || length < 1 || length > publicSafetyEvidenceLimits.recordingBytes || length !== message.byteLength || typeof message.digest !== 'string' || !/^[a-f0-9]{64}$/.test(message.digest)) throw new TypeError('Invalid execution result')
    return { version: 1, kind, buffer: message.buffer as ArrayBuffer, byteLength: length, digest: message.digest }
  }
  if (kind === 'finished') {
    const message = object(input, ['version', 'kind', 'outcome', 'transferred'])
    if (message.version !== 1 || !['completed', 'canceled', 'failed', 'refused'].includes(message.outcome as string) || typeof message.transferred !== 'boolean' || (message.outcome === 'completed') !== message.transferred) throw new TypeError('Invalid execution finish')
    return message as unknown as ExecutionWorkerMessage
  }
  throw new TypeError('Invalid execution protocol kind')
}
