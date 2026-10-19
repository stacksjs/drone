import type { PublicSafetyRun } from './runtime-types'
import { simulatePublicSafety } from './runtime'

export const publicSafetyEvidenceLimits = Object.freeze({ recordingBytes: 16 * 1024 * 1024, array: 262144, nodes: 4 * 1024 * 1024, depth: 32 })
const encoder = new TextEncoder()
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'length')!.get!
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!
function fail(reason: string): never { throw new TypeError(`Invalid public-safety recording: ${reason}`) }

/** Canonical bounded wire data. Descriptor inspection precedes traversal, with no toJSON or user iterator calls. */
export function publicSafetyRecordingData(input: unknown): string {
  const parts: string[] = [], ancestors = new Set<object>()
  let bytes = 0, nodes = 0
  function add(text: string, ascii = false) {
    bytes += ascii ? text.length : encoder.encode(text).length
    if (bytes > publicSafetyEvidenceLimits.recordingBytes) fail('source exceeds 16 MiB')
    parts.push(text)
  }
  function visit(value: unknown, depth: number): void {
    if (++nodes > publicSafetyEvidenceLimits.nodes || depth > publicSafetyEvidenceLimits.depth) fail('source structure budget')
    if (value === null || typeof value === 'boolean') { add(String(value), true); return }
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('non-finite source number'); add(JSON.stringify(value), true); return }
    if (typeof value === 'string') { if (value.length > 4096) fail('source text budget'); add(JSON.stringify(value)); return }
    if (!value || typeof value !== 'object') fail('unsupported source value')
    if (ancestors.has(value)) fail('cyclic source')
    if (Object.getOwnPropertySymbols(value).length) fail('symbolic source field')
    const prototype = Object.getPrototypeOf(value)
    const typed = prototype === Uint8Array.prototype || prototype === Uint16Array.prototype
    if (typed) {
      const length = typedLength.call(value) as number, buffer = typedBuffer.call(value)
      // Intrinsic brand checking rejects shared backing memory even if its public prototype was replaced.
      try { arrayBufferByteLength.call(buffer) }
      catch { fail('shared source memory') }
      if (length > publicSafetyEvidenceLimits.array) fail('image budget')
      const names = Object.getOwnPropertyNames(value)
      if (names.length !== length || names.some((name, i) => name !== String(i))) fail('extended numeric image')
      add('[', true)
      for (let i = 0; i < length; i++) { if (i) add(',', true); visit((value as Uint8Array | Uint16Array)[i], depth + 1) }
      add(']', true); return
    }
    const array = Array.isArray(value)
    if (prototype !== (array ? Array.prototype : Object.prototype)) fail('unsupported source prototype')
    const names = Object.getOwnPropertyNames(value)
    if (array && ((value as unknown[]).length > publicSafetyEvidenceLimits.array || names.length !== (value as unknown[]).length + 1)) fail('array source budget or sparse fields')
    if (!array && names.length > 128) fail('object source budget')
    const keys = array ? names.filter(key => key !== 'length') : names.sort()
    if (array && keys.some((key, i) => key !== String(i))) fail('extended source array')
    // Check every descriptor before reading even one field in this object.
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (key.length > 128 || !descriptor.enumerable || !('value' in descriptor)) fail('accessor or hidden source field')
    }
    ancestors.add(value); add(array ? '[' : '{', true)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!
      if (i) add(',', true)
      if (!array) add(`${JSON.stringify(key)}:`)
      visit(Object.getOwnPropertyDescriptor(value, key)!.value, depth + 1)
    }
    add(array ? ']' : '}', true); ancestors.delete(value)
  }
  visit(input, 0)
  return parts.join('')
}

/** Re-execute this pinned deterministic owned collection profile, including sensor/physics/shutter and incident decisions. */
export function validatePublicSafetyRun(input: unknown): PublicSafetyRun {
  const canonical = publicSafetyRecordingData(input)
  // Only plain data produced above is read. Input accessors and custom conversion cannot execute here.
  const source = JSON.parse(canonical) as PublicSafetyRun
  if (source.version !== 1 || source.evidence !== 'owned-public-safety-physics-simulation' || source.replayProfile !== 'owned-public-safety-collection-v1' || !source.plan || !source.plan.config) fail('unsupported owned replay profile')
  const replayed = simulatePublicSafety({ config: source.plan.config, scenario: source.scenario, seconds: source.seconds })
  if (publicSafetyRecordingData(replayed) !== canonical) fail('source differs from deterministic owned sensor/physics/incident replay')
  return replayed
}
export function publicSafetyRecordingJson(input: PublicSafetyRun): string {
  return publicSafetyRecordingData(validatePublicSafetyRun(input))
}
export function parsePublicSafetyRecording(text: string): PublicSafetyRun {
  if (typeof text !== 'string' || text.length > publicSafetyEvidenceLimits.recordingBytes || encoder.encode(text).length > publicSafetyEvidenceLimits.recordingBytes) fail('source exceeds 16 MiB')
  let input: unknown
  try { input = JSON.parse(text) }
  catch { fail('invalid source JSON') }
  return validatePublicSafetyRun(input)
}
