import type { IncidentRequest } from './http'
import { PublicSafetyAccessError } from './errors'
import { assertIncidentDeadline, associateIncidentDeadline, incidentDeadline } from './deadline'
import { execute, failure, privateHeaders, readBody } from './http'
import { authorizePublicSafetyHandover } from './handover-policy'
import { decideIncidentHandover, offerIncidentCoordination, readIncidentHandoverDesk } from './handover'

function incident(request: IncidentRequest) { return request.getParam('incident') ?? '' }
function query(request: IncidentRequest, reading = false) {
  const values = new URL(request.url).searchParams
  const allowed = reading ? ['offer', 'after', 'limit'] : []
  if ([...values.keys()].some(name => !allowed.includes(name) || values.getAll(name).length !== 1)) throw new PublicSafetyAccessError(422, 'Invalid handover query')
  const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
    const value = values.get(name)
    if (value === null) return fallback
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value || Number(value) < minimum || Number(value) > maximum) throw new PublicSafetyAccessError(422, 'Invalid handover cursor')
    return Number(value)
  }
  return { ...(values.has('offer') ? { offerKey: values.get('offer')! } : {}), afterSequence: integer('after', 0, 0, 2147483647), limit: integer('limit', 100, 1, 100) }
}
export function readHandoverDeskHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = incident(request)
    await authorizePublicSafetyHandover(key, 'read')
    return readIncidentHandoverDesk(key, query(request, true))
  })
}
export async function offerHandoverHttp(request: IncidentRequest): Promise<Response> {
  try {
    const key = incident(request)
    await authorizePublicSafetyHandover(key, 'write')
    query(request)
    const receipt = await offerIncidentCoordination(key, await readBody(request, 8192))
    assertIncidentDeadline(receipt)
    const response = associateIncidentDeadline(Response.json(receipt, { status: receipt.replayed ? 200 : 201, headers: privateHeaders }), incidentDeadline(receipt))
    assertIncidentDeadline(response)
    return response
  }
  catch (error) { return failure(error) }
}
export function decideHandoverHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = incident(request)
    await authorizePublicSafetyHandover(key, 'write')
    query(request)
    return decideIncidentHandover(key, await readBody(request, 8192))
  })
}
