import type { IncidentRequest } from '../access/http'
import { PublicSafetyAccessError } from '../access/errors'
import { execute, failure, privateHeaders, readBody } from '../access/http'
import { assertIncidentDeadline, associateIncidentDeadline, incidentDeadline } from '../access/deadline'
import { authorizePublicSafetyPurge } from './policy'
import { acceptPublicSafetyPurge, listPublicSafetyPurgeEvents, previewPublicSafetyPurge, readPublicSafetyPurge, retryPublicSafetyPurge } from './service'

function incident(request: IncidentRequest) { return request.getParam('incident') ?? '' }
function purge(request: IncidentRequest) { return request.getParam('purge') ?? '' }
function query(request: IncidentRequest, paginated = false) {
  const values = new URL(request.url).searchParams
  if ([...values.keys()].some(name => !paginated || name !== 'after' && name !== 'limit') || values.getAll('after').length > 1 || values.getAll('limit').length > 1) throw new PublicSafetyAccessError(422, 'Invalid purge query')
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = values.get(name)
    if (value === null) return fallback
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value || Number(value) < min || Number(value) > max) throw new PublicSafetyAccessError(422, 'Invalid purge cursor')
    return Number(value)
  }
  return { after: integer('after', 0, 0, 2147483647), limit: integer('limit', 100, 1, 100) }
}

export function previewPurgeHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = incident(request)
    await authorizePublicSafetyPurge(key, 'preview')
    query(request)
    return previewPublicSafetyPurge(key)
  })
}
export async function acceptPurgeHttp(request: IncidentRequest): Promise<Response> {
  try {
    const key = incident(request)
    await authorizePublicSafetyPurge(key, 'accept')
    query(request)
    const receipt = await acceptPublicSafetyPurge(key, await readBody(request, 8192))
    assertIncidentDeadline(receipt)
    const result = associateIncidentDeadline(Response.json(receipt, { status: receipt.replayed ? 200 : 202, headers: privateHeaders }), incidentDeadline(receipt))
    assertIncidentDeadline(result)
    return result
  }
  catch (error) { return failure(error) }
}
export function readPurgeHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = incident(request)
    await authorizePublicSafetyPurge(key, 'read')
    query(request)
    return readPublicSafetyPurge(key, purge(request))
  })
}
export function listPurgeEventsHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = incident(request)
    await authorizePublicSafetyPurge(key, 'events')
    return listPublicSafetyPurgeEvents(key, purge(request), query(request, true))
  })
}
export async function retryPurgeHttp(request: IncidentRequest): Promise<Response> {
  try {
    const key = incident(request)
    await authorizePublicSafetyPurge(key, 'retry')
    query(request)
    const receipt = await retryPublicSafetyPurge(key, purge(request), await readBody(request, 8192))
    assertIncidentDeadline(receipt)
    const result = associateIncidentDeadline(Response.json(receipt, { status: receipt.replayed ? 200 : 202, headers: privateHeaders }), incidentDeadline(receipt))
    assertIncidentDeadline(result)
    return result
  }
  catch (error) { return failure(error) }
}
