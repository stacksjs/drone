import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { normalizePatrolInput } from '../patrol'

export class PatrolReviewError extends Error {
  constructor(readonly status: 401 | 403 | 404 | 409 | 422 | 500 | 503) { super('Patrol review request failed') }
}
export const canonicalVersion = 'patrol-auth-review-v1'
export const anchorUtcMs = 1767225600000
export const recurrenceProfile = 'minute-zero-one-v1'
export const origin = '{"latitudeDeg":0,"longitudeDeg":0,"ellipsoidHeightM":100}'
export const safety = Object.freeze({ actorIdentityAuthenticated: true, bindingIdentityAuthenticated: false, launchAuthorized: false, chargeAuthorized: false, physicalFlightEnabled: false, executionState: 'not-requested', handoff: null })
const keyPattern = /^[a-z][a-z0-9-]{0,39}$/
const requestPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

export function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Invalid patrol object')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(k => !descriptors[k]?.enumerable || !('value' in descriptors[k]!))) throw new TypeError('Invalid patrol fields')
  return Object.fromEntries(keys.map(k => [k, descriptors[k]!.value]))
}
export function key(value: unknown): string {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw new TypeError('Invalid patrol key')
  return value
}
export function requestId(value: unknown): string {
  if (typeof value !== 'string' || !requestPattern.test(value)) throw new TypeError('Invalid patrol request ID')
  return value
}
export function databaseId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid patrol database ID')
  return value
}
export function iso(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new TypeError('Invalid patrol UTC timestamp')
  const ms = Date.parse(value)
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 253402300799999 || new Date(ms).toISOString() !== value) throw new TypeError('Invalid patrol UTC timestamp')
  return value
}
function uint64(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) throw new TypeError('Invalid declared identifier')
  return value
}
export function json(value: unknown, maxBytes: number): string {
  const text = JSON.stringify(value)
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) throw new TypeError('Patrol projection exceeds its bound')
  return text
}
export function sha(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex') }

export function normalizeInput(value: unknown) {
  const v = data(value, ['profile', 'unsignedLocalReview', 'enableCharge', 'decisions'])
  const source = v.decisions
  if (!Array.isArray(source) || types.isProxy(source) || Object.getPrototypeOf(source) !== Array.prototype) throw new TypeError('Invalid patrol decisions')
  const descriptors = Object.getOwnPropertyDescriptors<object>(source), length = descriptors.length
  if (!length || !('value' in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 1 || length.value > 2 || Reflect.ownKeys(descriptors).length !== length.value + 1) throw new TypeError('Invalid patrol decisions')
  const entries = []
  for (let n = 0; n < length.value; n++) {
    const d = descriptors[String(n)]
    if (!d?.enumerable || !('value' in d)) throw new TypeError('Invalid patrol decision index')
    entries.push(data(d.value, ['kind', 'id', 'atMs', 'dueUtcMs', 'decision']))
  }
  const normalized = normalizePatrolInput({ profile: v.profile, unsignedLocalReview: v.unsignedLocalReview, enableCharge: v.enableCharge, decisions: entries })
  if (!normalized.unsignedLocalReview || normalized.enableCharge) throw new TypeError('Invalid authenticated patrol intent')
  const decisions = normalized.decisions.map(d => {
    if (d.kind !== 'flight' || d.decision !== 'approve' || d.atMs !== (d.dueUtcMs === anchorUtcMs ? 2000 : 60000)) throw new TypeError('Invalid authenticated flight intent')
    return Object.freeze({ kind: 'flight' as const, id: d.id, atMs: d.atMs, dueUtcMs: d.dueUtcMs, decision: 'approve' as const })
  })
  const result = Object.freeze({ profile: 'nominal' as const, unsignedLocalReview: true as const, enableCharge: false as const, decisions: Object.freeze(decisions) })
  json(result, 1024)
  return result
}
export function normalizeBinding(value: unknown) {
  const v = data(value, ['vehicleId', 'padId', 'planId', 'profile', 'sessionId', 'bootId', 'reference', 'origin'])
  if (v.vehicleId !== 'navigation-vehicle' || v.padId !== 'pad' || v.planId !== 'local-survey-demo' || v.profile !== 'nominal-contact-partial-charge-v1' || v.origin !== origin) throw new TypeError('Invalid declared patrol frame')
  const sessionId = uint64(v.sessionId), bootId = uint64(v.bootId)
  if (typeof v.reference !== 'string' || v.reference.length > 105 || !v.reference.startsWith(`${bootId}:`)) throw new TypeError('Invalid declared reference')
  const resets = v.reference.slice(bootId.length + 1).split(',')
  if (resets.length !== 5 || resets.some(n => !/^(?:0|[1-9][0-9]{0,15})$/.test(n) || BigInt(n) > BigInt(Number.MAX_SAFE_INTEGER))) throw new TypeError('Invalid declared resets')
  const result = Object.freeze({ vehicleId: 'navigation-vehicle' as const, padId: 'pad' as const, planId: 'local-survey-demo' as const, profile: 'nominal-contact-partial-charge-v1' as const, sessionId, bootId, reference: v.reference, origin })
  json(result, 1024)
  return result
}
export function normalizeCreate(value: unknown) {
  const v = data(value, ['requestId', 'scheduleKey', 'input', 'binding'])
  return Object.freeze({ requestId: requestId(v.requestId), scheduleKey: key(v.scheduleKey), input: normalizeInput(v.input), binding: normalizeBinding(v.binding) })
}
export type Creation = ReturnType<typeof normalizeCreate>
export function digests(input: Creation['input'], binding: Creation['binding']) {
  return { inputDigest: sha({ canonicalVersion, kind: 'input', input }), bindingDigest: sha({ canonicalVersion, kind: 'declared-binding', binding }) }
}
export function scopeDigest(ownerUserId: number, scheduleKey: string, dueUtcMs: number, inputDigest: string, bindingDigest: string) {
  return sha({ canonicalVersion, kind: 'occurrence-scope', ownerUserId, scheduleKey, revision: 1, model: 'owned-patrol-simulation', profile: 'nominal', recurrenceProfile, bindingProfile: 'nominal-contact-partial-charge-v1', anchorUtcMs, horizonMs: 180000, dueUtcMs, inputDigest, bindingDigest })
}
export function createRequestDigest(ownerUserId: number, body: Creation) {
  return sha({ canonicalVersion, kind: 'request', ownerUserId, scheduleKey: body.scheduleKey, revision: 1, operation: 'create', dueUtcMs: null, body })
}

export function utcMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > 253402300799999) throw new TypeError('Invalid patrol UTC value')
  iso(new Date(value).toISOString())
  return value
}
export function routeDue(value: string): number {
  const due = utcMs(Number(value))
  if (String(due) !== value) throw new TypeError('Invalid patrol due path')
  return due
}
export function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw new TypeError('Invalid patrol version')
  return value
}
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('Invalid patrol digest')
  return value
}
export function normalizeDecision(value: unknown) {
  const v = data(value, ['expectedVersion', 'requestId', 'scopeDigest', 'decision'])
  if (v.decision !== 'approve' && v.decision !== 'deny') throw new TypeError('Invalid patrol decision')
  return Object.freeze({ expectedVersion: version(v.expectedVersion), requestId: requestId(v.requestId), scopeDigest: digest(v.scopeDigest), decision: v.decision })
}
export function normalizeConsume(value: unknown) {
  const v = data(value, ['expectedVersion', 'requestId', 'scopeDigest'])
  return Object.freeze({ expectedVersion: version(v.expectedVersion), requestId: requestId(v.requestId), scopeDigest: digest(v.scopeDigest) })
}
export function transitionDigest(ownerUserId: number, scheduleKey: string, dueUtcMs: number, operation: 'approve' | 'deny' | 'consume', body: ReturnType<typeof normalizeDecision> | ReturnType<typeof normalizeConsume>) {
  return sha({ canonicalVersion, kind: 'request', ownerUserId, scheduleKey, revision: 1, operation, dueUtcMs, body })
}

/** Exact identity observed from the installed native SQLite path, never response or message inference. */
export function isPatrolDatabaseBusy(error: unknown): boolean {
  return error instanceof Error && 'code' in error && 'errno' in error
    && (error.code === 'SQLITE_BUSY' && error.errno === 5 || error.code === 'SQLITE_BUSY_SNAPSHOT' && error.errno === 517)
}
