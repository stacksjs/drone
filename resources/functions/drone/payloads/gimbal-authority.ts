import { types as nodeTypes } from 'node:util'
import type { SensorVector } from '../sensors/types'

export type GimbalInhibitCode = 'gimbal-source-expired' | 'gimbal-command-invalid' | 'gimbal-command-replay' | 'gimbal-observation-invalid' | 'gimbal-reference-changed' | 'gimbal-clock-discontinuity' | 'gimbal-policy-gap' | 'gimbal-manual-override' | 'gimbal-operator-neutral' | 'gimbal-authority-unavailable' | 'gimbal-counter-exhausted'
export type GimbalPhase = 'waiting' | 'active' | 'inhibited' | 'retired'
export interface GimbalConfiguration { version: 1, sessionId: string, epoch: number, sourceKind: 'operator' | 'autonomy', sourceId: string, reference: string, maxJointAngleRad: SensorVector }
export interface GimbalCommandToken { epoch: number, sequence: number, issuedAtMs: number, expiresAtMs: number, goalRad: SensorVector }
export interface GimbalInhibit { atMs: number | null, code: GimbalInhibitCode }
export interface GimbalTransition { atMs: number | null, from: GimbalPhase, to: GimbalPhase, reason: 'selected-command' | GimbalInhibitCode | 'session-retired' }
export interface GimbalSnapshot {
  version: 1
  phase: GimbalPhase
  selection: GimbalConfiguration
  lastAccepted: GimbalCommandToken | null
  firstInhibit: GimbalInhibit | null
  counters: { observations: number, acceptedCommands: number, rejectedForeignCommands: number, rejectedUnattributedCommands: number, rejectedSelectedCommands: number }
  transitions: GimbalTransition[]
}
export interface GimbalDecision { snapshot: GimbalSnapshot, directive: 'joint-angle' | 'zero-requested-torque', goalRad: SensorVector | null, commandAccepted: boolean, rejection: null | 'foreign' | 'unattributed-invalid' | 'selected-invalid' | 'inhibited' | 'retired' }

function record(input: unknown): PropertyDescriptorMap | null {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return null
  return Object.getOwnPropertyDescriptors(input)
}
function exact(d: PropertyDescriptorMap, keys: string[]): boolean {
  const own = Reflect.ownKeys(d)
  return own.length === keys.length && own.every(k => typeof k === 'string' && keys.includes(k) && d[k]!.enumerable && Object.hasOwn(d[k]!, 'value'))
}
function value(d: PropertyDescriptorMap, key: string): unknown { const p = d[key]; return p?.enumerable && Object.hasOwn(p, 'value') ? p.value : undefined }
function id(v: unknown): v is string { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v) }
function reference(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 96 && !/[^ -~]/.test(v)
}
function kind(v: unknown): v is GimbalConfiguration['sourceKind'] { return v === 'operator' || v === 'autonomy' }
function uint(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4294967295
}
function time(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER - 100
}
function tuple(input: unknown): SensorVector | null {
  if (nodeTypes.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return null
  const source: object = input
  const d = Object.getOwnPropertyDescriptors(source)
  if (Reflect.ownKeys(d).length !== 4 || d.length?.value !== 3 || !['0', '1', '2'].every(k => d[k]?.enumerable && Object.hasOwn(d[k]!, 'value'))) return null
  const a: unknown = d[0]!.value, b: unknown = d[1]!.value, c: unknown = d[2]!.value
  return typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b) && typeof c === 'number' && Number.isFinite(c) ? [a, b, c] : null
}
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v) + '\n').length
function resultUnavailable(): never { throw new RangeError('gimbal-authority-result') }

/** Trusted in-process immutable writer and finite angle lease. No transport or physical watchdog. */
export function createGimbalAuthority(configuration: unknown) {
  let selection: GimbalConfiguration
  try {
    const d = record(configuration)
    if (!d || !exact(d, ['version', 'sessionId', 'epoch', 'sourceKind', 'sourceId', 'reference', 'maxJointAngleRad'])) throw new TypeError()
    const sessionId = value(d, 'sessionId'), epoch = value(d, 'epoch'), sourceKind = value(d, 'sourceKind'), sourceId = value(d, 'sourceId'), ref = value(d, 'reference'), travel = tuple(value(d, 'maxJointAngleRad'))
    if (value(d, 'version') !== 1 || !id(sessionId) || !uint(epoch) || !kind(sourceKind) || !id(sourceId) || !reference(ref) || !travel || !travel.every(n => n > 0 && n <= Math.PI)) throw new TypeError()
    selection = { version: 1, sessionId, epoch, sourceKind, sourceId, reference: ref, maxJointAngleRad: travel }
  }
  catch { throw new TypeError('gimbal-authority-input') }
  const state: GimbalSnapshot = { version: 1, phase: 'waiting', selection, lastAccepted: null, firstInhibit: null, counters: { observations: 0, acceptedCommands: 0, rejectedForeignCommands: 0, rejectedUnattributedCommands: 0, rejectedSelectedCommands: 0 }, transitions: [] }
  let lastNow: number | null = null
  function transition(to: GimbalPhase, reason: GimbalTransition['reason'], atMs: number | null) {
    if (state.transitions.length >= 16) resultUnavailable()
    state.transitions.push({ atMs, from: state.phase, to, reason }); state.phase = to
  }
  function inhibit(code: GimbalInhibitCode, atMs: number | null) {
    if (!state.firstInhibit) { state.firstInhibit = { atMs, code }; transition('inhibited', code, atMs) }
  }
  function snapshot(): GimbalSnapshot {
    if (size(state.selection) > 1024 || size(state.lastAccepted) > 512 || size(state.firstInhibit) > 256 || size(state.counters) > 256 || state.transitions.some(t => size(t) > 256) || size(state) > 8192) resultUnavailable()
    return structuredClone(state)
  }
  function decision(commandAccepted: boolean, rejection: GimbalDecision['rejection']): GimbalDecision {
    const active = state.phase === 'active', goalRad = active && state.lastAccepted ? [...state.lastAccepted.goalRad] : null
    const out: GimbalDecision = { snapshot: snapshot(), directive: active ? 'joint-angle' : 'zero-requested-torque', goalRad: goalRad ? [goalRad[0]!, goalRad[1]!, goalRad[2]!] : null, commandAccepted, rejection }
    if (size(out) > 12288) resultUnavailable()
    return out
  }
  function fail(code: GimbalInhibitCode, atMs: number | null): GimbalDecision { inhibit(code, atMs); return decision(false, 'inhibited') }
  function step(observation: unknown, command?: unknown): GimbalDecision {
    if (state.phase === 'inhibited' || state.phase === 'retired') return decision(false, state.phase)
    const d = record(observation)
    if (!d || !exact(d, ['nowMs', 'reference', 'authorityGranted', 'neutralRequested', 'manualOverride'])) return fail('gimbal-observation-invalid', null)
    const n = value(d, 'nowMs'), ref = value(d, 'reference'), grant = value(d, 'authorityGranted'), neutral = value(d, 'neutralRequested'), manual = value(d, 'manualOverride')
    if (!reference(ref) || typeof grant !== 'boolean' || typeof neutral !== 'boolean' || typeof manual !== 'boolean') return fail('gimbal-observation-invalid', null)
    if (!time(n) || lastNow !== null && n < lastNow) return fail('gimbal-clock-discontinuity', null)
    const gap = lastNow !== null && n - lastNow > 40
    lastNow = n
    if (gap) return fail('gimbal-policy-gap', n)
    if (state.counters.observations === 4096) return fail('gimbal-counter-exhausted', n)
    state.counters.observations++
    if (manual) return fail('gimbal-manual-override', n)
    if (neutral) return fail('gimbal-operator-neutral', n)
    if (state.phase === 'active' && !grant) return fail('gimbal-authority-unavailable', n)
    if (ref !== selection.reference) return fail('gimbal-reference-changed', n)
    if (state.phase === 'active' && state.lastAccepted && n >= state.lastAccepted.expiresAtMs) return fail('gimbal-source-expired', n)
    if (command === undefined) return decision(false, null)
    const packet = record(command)
    const sourceKind = packet && value(packet, 'sourceKind'), sourceId = packet && value(packet, 'sourceId')
    if (!packet || !kind(sourceKind) || !id(sourceId)) { state.counters.rejectedUnattributedCommands++; return decision(false, 'unattributed-invalid') }
    if (sourceKind !== selection.sourceKind || sourceId !== selection.sourceId) { state.counters.rejectedForeignCommands++; return decision(false, 'foreign') }
    const eventAt = n
    function reject(code: GimbalInhibitCode): GimbalDecision { state.counters.rejectedSelectedCommands++; inhibit(code, eventAt); return decision(false, 'selected-invalid') }
    if (!exact(packet, ['version', 'sessionId', 'epoch', 'sourceKind', 'sourceId', 'reference', 'sequence', 'issuedAtMs', 'leaseMs', 'mode', 'jointAngleRad'])) return reject('gimbal-command-invalid')
    const sequence = value(packet, 'sequence'), issued = value(packet, 'issuedAtMs'), lease = value(packet, 'leaseMs'), angles = tuple(value(packet, 'jointAngleRad'))
    if (value(packet, 'version') !== 1 || value(packet, 'sessionId') !== selection.sessionId || value(packet, 'epoch') !== selection.epoch || value(packet, 'reference') !== selection.reference || value(packet, 'mode') !== 'joint-angle' || !uint(sequence) || !time(issued) || issued > n || n - issued > 100 || typeof lease !== 'number' || !Number.isInteger(lease) || lease < 20 || lease > 100 || n >= issued + lease || !angles || angles.some((a, i) => Math.abs(a) > selection.maxJointAngleRad[i]!)) return reject('gimbal-command-invalid')
    if (state.lastAccepted && (sequence <= state.lastAccepted.sequence || issued <= state.lastAccepted.issuedAtMs)) return reject('gimbal-command-replay')
    if (!grant) return decision(false, null)
    state.lastAccepted = { epoch: selection.epoch, sequence, issuedAtMs: issued, expiresAtMs: issued + lease, goalRad: angles }
    state.counters.acceptedCommands++
    if (state.phase === 'waiting') transition('active', 'selected-command', n)
    return decision(true, null)
  }
  function retire(nowMs: unknown): GimbalSnapshot {
    if (state.phase === 'retired') return snapshot()
    if (!time(nowMs) || lastNow !== null && nowMs < lastNow) {
      if (state.phase !== 'inhibited') inhibit('gimbal-clock-discontinuity', null)
      return snapshot()
    }
    lastNow = nowMs; transition('retired', 'session-retired', nowMs)
    return snapshot()
  }
  return { step, snapshot, retire }
}
