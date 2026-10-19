import { publicSafetyEvidenceLimits } from '../evidence'
import { PublicSafetyAccessError } from './errors'
import type { IncidentRequest } from './http'
import { execute, readBody } from './http'
import { authorizePublicSafetyIncident } from './service'
import { registerPublicSafetySource, readPublicSafetySource, listPublicSafetySources, appendPublicSafetyObservation, readPublicSafetyObservation, listPublicSafetyObservations, appendPublicSafetyReview, listPublicSafetyReviews } from './records'

/** These routes accept only the pinned wire query. Identity never comes from query aliases. */
function query(request: IncidentRequest, paginated = false) {
  const values = new URL(request.url).searchParams
  if ([...values.keys()].some(name => !paginated || name !== 'after' && name !== 'limit') || values.getAll('after').length > 1 || values.getAll('limit').length > 1) throw new PublicSafetyAccessError(422, 'Invalid evidence query')
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = values.get(name)
    if (value === null) return fallback
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value || Number(value) < min || Number(value) > max) throw new PublicSafetyAccessError(422, 'Invalid evidence cursor')
    return Number(value)
  }
  return { afterSequence: integer('after', 0, 0, 2147483647), limit: integer('limit', 100, 1, 100) }
}
function key(request: IncidentRequest) { return request.getParam('incident') ?? '' }
function digest(request: IncidentRequest) {
  const value = request.getParam('digest') ?? ''
  if (value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) throw new PublicSafetyAccessError(422, 'Invalid source digest')
  return value
}
function observation(request: IncidentRequest) {
  const value = request.getParam('observation') ?? ''
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value) throw new PublicSafetyAccessError(422, 'Invalid observation identifier')
  return Number(value)
}
export function registerSourceHttp(request: IncidentRequest) {
  return execute(async () => {
    const incident = key(request)
    await authorizePublicSafetyIncident(incident, 'source-register')
    query(request)
    return registerPublicSafetySource(incident, await readBody(request, publicSafetyEvidenceLimits.recordingBytes + 4096))
  }, 201)
}
export function readSourceHttp(request: IncidentRequest) {
  return execute(async () => { const incident = key(request); await authorizePublicSafetyIncident(incident, 'view'); query(request); return readPublicSafetySource(incident, digest(request)) })
}
export function listSourcesHttp(request: IncidentRequest) {
  return execute(async () => { const incident = key(request); await authorizePublicSafetyIncident(incident, 'view'); return listPublicSafetySources(incident, query(request, true)) })
}
export function appendObservationHttp(request: IncidentRequest) {
  return execute(async () => {
    const incident = key(request)
    await authorizePublicSafetyIncident(incident, 'observation-create')
    query(request)
    return appendPublicSafetyObservation(incident, await readBody(request, 8192))
  }, 201)
}
export function readObservationHttp(request: IncidentRequest) {
  return execute(async () => { const incident = key(request); await authorizePublicSafetyIncident(incident, 'view'); query(request); return readPublicSafetyObservation(incident, observation(request)) })
}
export function listObservationsHttp(request: IncidentRequest) {
  return execute(async () => { const incident = key(request); await authorizePublicSafetyIncident(incident, 'view'); return listPublicSafetyObservations(incident, query(request, true)) })
}
export function appendReviewHttp(request: IncidentRequest) {
  return execute(async () => {
    const incident = key(request)
    await authorizePublicSafetyIncident(incident, 'review-append')
    query(request)
    const id = observation(request)
    return appendPublicSafetyReview(incident, id, await readBody(request, 8192))
  }, 201)
}
export function listReviewsHttp(request: IncidentRequest) {
  return execute(async () => { const incident = key(request); await authorizePublicSafetyIncident(incident, 'view'); return listPublicSafetyReviews(incident, observation(request), query(request, true)) })
}
