import type { IncidentRequest } from '../access/http'
import { PublicSafetyAccessError } from '../access/errors'
import { execute, readBody } from '../access/http'
import { authorizePublicSafetyRetention } from './policy'
import { previewPublicSafetyRetention, enrollPublicSafetyRetention, readPublicSafetyRetention, reviewPublicSafetyRetentionHold, listPublicSafetyRetentionEvents, revokePublicSafetyCustodyMember } from './service'

function query(request: IncidentRequest, paginated = false) {
  const values = new URL(request.url).searchParams
  if ([...values.keys()].some(name => !paginated || name !== 'after' && name !== 'limit') || values.getAll('after').length > 1 || values.getAll('limit').length > 1) throw new PublicSafetyAccessError(422, 'Invalid retention query')
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = values.get(name)
    if (value === null) return fallback
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value || Number(value) < min || Number(value) > max) throw new PublicSafetyAccessError(422, 'Invalid retention cursor')
    return Number(value)
  }
  return { afterSequence: integer('after', 0, 0, 2147483647), limit: integer('limit', 100, 1, 100) }
}
function key(request: IncidentRequest) { return request.getParam('incident') ?? '' }

export function previewRetentionHttp(request: IncidentRequest) {
  return execute(async () => {
    const incident = key(request)
    await authorizePublicSafetyRetention(incident, 'read')
    query(request)
    return previewPublicSafetyRetention(incident)
  })
}
export function enrollRetentionHttp(request: IncidentRequest) {
  return execute(async () => {
    const incident = key(request)
    await authorizePublicSafetyRetention(incident, 'manage')
    query(request)
    return enrollPublicSafetyRetention(incident, await readBody(request, 8192))
  })
}
export function readRetentionHttp(request: IncidentRequest) {
  return execute(async () => {
    const incident = key(request)
    await authorizePublicSafetyRetention(incident, 'read')
    query(request)
    return readPublicSafetyRetention(incident)
  })
}
export function reviewRetentionHoldHttp(request: IncidentRequest) {
  return execute(async () => {
    const incident = key(request)
    await authorizePublicSafetyRetention(incident, 'manage')
    query(request)
    return reviewPublicSafetyRetentionHold(incident, await readBody(request, 8192))
  })
}
export function listRetentionEventsHttp(request: IncidentRequest) {
  return execute(async () => {
    const incident = key(request)
    await authorizePublicSafetyRetention(incident, 'read')
    return listPublicSafetyRetentionEvents(incident, query(request, true))
  })
}
export function revokeCustodyMemberHttp(request: IncidentRequest) {
  return execute(async () => {
    const incident = key(request)
    await authorizePublicSafetyRetention(incident, 'revoke')
    query(request)
    return revokePublicSafetyCustodyMember(incident, await readBody(request, 8192))
  })
}
