import type { WorkspaceOptions } from './types'
import { types } from 'node:util'
import { PublicSafetyAccessError } from '../access/errors'
import { maximumVersion } from '../access/mutations'
import { handoverUuid } from '../access/handover-ledger'

function invalid(): never { throw new PublicSafetyAccessError(422, 'Invalid workspace options or cursor') }
export function workspaceInteger(value: unknown, maximum = maximumVersion): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
  return value
}
export function workspaceOptions(input: WorkspaceOptions) {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const allowed = ['sourceDigest', 'sourcesAfterSequence', 'contextCursor', 'offerKey', 'handoverAfterSequence', 'membersAfterUserId', 'limit']
  const out: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.includes(key) || !descriptor.enumerable || !('value' in descriptor)) invalid()
    out[key] = descriptor.value
  }
  if ('sourceDigest' in out && (typeof out.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(out.sourceDigest))) invalid()
  if ('contextCursor' in out && (typeof out.contextCursor !== 'string' || out.contextCursor.length > 768 || !out.sourceDigest)) invalid()
  if ('offerKey' in out) handoverUuid(out.offerKey)
  const limit = 'limit' in out ? workspaceInteger(out.limit, 100) : 50
  if (!limit) invalid()
  return { sourceDigest: out.sourceDigest as string | undefined, contextCursor: out.contextCursor as string | undefined, offerKey: out.offerKey as string | undefined, sourcesAfter: 'sourcesAfterSequence' in out ? workspaceInteger(out.sourcesAfterSequence) : 0, handoverAfter: 'handoverAfterSequence' in out ? workspaceInteger(out.handoverAfterSequence) : 0, membersAfter: 'membersAfterUserId' in out ? workspaceInteger(out.membersAfterUserId, Number.MAX_SAFE_INTEGER) : 0, limit }
}
export function contextCursor(scope: string, digest: string, through: number, after: number): string {
  return Buffer.from(JSON.stringify([1, scope, digest, through, after])).toString('base64url')
}
export function readContextCursor(cursor: string | undefined, scope: string, digest: string, current: number): { through: number, after: number } {
  if (cursor === undefined) return { through: current, after: 0 }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) invalid()
  let facts: unknown
  try { facts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) }
  catch { return invalid() }
  if (!Array.isArray(facts) || facts.length !== 5 || facts[0] !== 1 || facts[1] !== scope || facts[2] !== digest) invalid()
  const through = workspaceInteger(facts[3]), after = workspaceInteger(facts[4])
  if (through > current || after > through || contextCursor(scope, digest, through, after) !== cursor) invalid()
  return { through, after }
}
