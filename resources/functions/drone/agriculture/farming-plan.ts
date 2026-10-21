import type { AgricultureConfig, AgriculturePlan } from './types'
import { createAgriculturePlan } from './planner'

export interface FarmingPlanningRequest {
  version: 1
  operation: 'agriculture-observation-plan'
  requestId: string
  context: { farmId: number, fieldId: number, declarationId: string }
  geometry: {
    frame: 'LOCAL_NED'
    horizontalUnit: 'm'
    heightDatum: 'WGS84_ELLIPSOID'
    evidence: 'operator-declared-metric'
    sourceReference: string
  }
  config: AgricultureConfig
}
export interface FarmingPlanningPreview {
  version: 1
  kind: 'farming-observation-planning-preview'
  operation: 'agriculture-observation-plan'
  status: 'planned'
  requestId: string
  context: FarmingPlanningRequest['context']
  source: { sha256: string, byteLength: number, encoding: 'utf-8' }
  geometry: FarmingPlanningRequest['geometry']
  plan: AgriculturePlan
  ownershipVerified: false
  geometryVerified: false
  physicalFlightEnabled: false
  observationPerformed: false
  dispatchPerformed: false
}

const requestLimit = 262144
const resultLimit = 524288
function invalid(): never { throw new TypeError('farming-plan-input') }
function unavailable(): never { throw new Error('farming-plan-unavailable') }
function fields(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const keys = Object.keys(value)
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) invalid()
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) invalid()
}
function rowId(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid()
}
function wellFormed(text: string): void {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const low = text.charCodeAt(++index)
      if (!(low >= 0xDC00 && low <= 0xDFFF)) invalid()
    }
    else if (code >= 0xDC00 && code <= 0xDFFF) invalid()
  }
}
/** Only privately parsed data and the owned planner result cross this serializer check. */
function ordinary(value: unknown, active = new Set<object>()): void {
  if (typeof value === 'number') { if (!Number.isFinite(value)) unavailable(); return }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value !== 'object' || active.has(value)) unavailable()
  const array = Array.isArray(value)
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) unavailable()
  active.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (array) {
    const length = Object.getOwnPropertyDescriptor(value, 'length')
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0 || keys.length !== length.value + 1) unavailable()
    for (let index = 0; index < length.value; index++) if (!Object.hasOwn(descriptors, String(index))) unavailable()
  }
  for (const key of keys) {
    if (array && key === 'length') continue
    if (typeof key !== 'string') unavailable()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) unavailable()
    if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) unavailable()
    ordinary(descriptor.value, active)
  }
  active.delete(value)
}

/** Explicit declared-field planning only. No observations, dispatch or authenticated ownership. */
export async function planFarmingObservation(requestJson: string): Promise<FarmingPlanningPreview> {
  if (typeof requestJson !== 'string' || requestJson.length === 0) invalid()
  if (requestJson.length > requestLimit) throw new RangeError('farming-plan-limit')
  wellFormed(requestJson)
  let bytes: Uint8Array<ArrayBuffer>
  try { bytes = new TextEncoder().encode(requestJson) }
  catch { return unavailable() }
  if (bytes.byteLength > requestLimit) throw new RangeError('farming-plan-limit')
  let input: unknown
  try { input = JSON.parse(requestJson) }
  catch { return invalid() }
  fields(input, ['version', 'operation', 'requestId', 'context', 'geometry', 'config'])
  if (input.version !== 1 || input.operation !== 'agriculture-observation-plan') invalid()
  const requestId = input.requestId
  identifier(requestId)
  const context = input.context
  fields(context, ['farmId', 'fieldId', 'declarationId'])
  const { farmId, fieldId, declarationId } = context
  rowId(farmId); rowId(fieldId); identifier(declarationId)
  const geometry = input.geometry
  fields(geometry, ['frame', 'horizontalUnit', 'heightDatum', 'evidence', 'sourceReference'])
  if (geometry.frame !== 'LOCAL_NED' || geometry.horizontalUnit !== 'm' || geometry.heightDatum !== 'WGS84_ELLIPSOID' || geometry.evidence !== 'operator-declared-metric') invalid()
  const sourceReference = geometry.sourceReference
  identifier(sourceReference)
  if (typeof globalThis.structuredClone !== 'function') unavailable()
  let plan: AgriculturePlan
  try { plan = createAgriculturePlan(input.config) }
  catch { throw new Error('farming-plan-rejected') }
  const result: FarmingPlanningPreview = {
    version: 1, kind: 'farming-observation-planning-preview', operation: 'agriculture-observation-plan', status: 'planned', requestId,
    context: { farmId, fieldId, declarationId },
    source: { sha256: '0'.repeat(64), byteLength: bytes.byteLength, encoding: 'utf-8' },
    geometry: { frame: 'LOCAL_NED', horizontalUnit: 'm', heightDatum: 'WGS84_ELLIPSOID', evidence: 'operator-declared-metric', sourceReference },
    plan, ownershipVerified: false, geometryVerified: false, physicalFlightEnabled: false, observationPerformed: false, dispatchPerformed: false,
  }
  let outputBytes: number
  try {
    ordinary(result)
    outputBytes = new TextEncoder().encode(JSON.stringify(result) + '\n').byteLength
  }
  catch { return unavailable() }
  if (outputBytes > resultLimit) throw new RangeError('farming-plan-limit')
  try {
    // The private original UTF8 snapshot was admitted before the first await.
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    if (digest.byteLength !== 32) return unavailable()
    result.source.sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  }
  catch { return unavailable() }
  // The digest replaces only a private64-character ASCII placeholder, preserving the wire bound.
  return result
}
