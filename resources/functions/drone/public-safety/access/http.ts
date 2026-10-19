import { createMiddlewareErrorResponse, readJsonBody, RequestBodyError } from '@stacksjs/router'
import { PublicSafetyAccessError } from './errors'
import { associateManagedDownload, managedDownloadDeadline } from '../managed/download-deadline'
import { authorizePublicSafetyCreate, authorizePublicSafetyIncident, changePublicSafetyMembership, closePublicSafetyIncident, createPublicSafetyIncident, readPublicSafetyAudit, readPublicSafetyIncident } from './service'

export const privateHeaders = { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization, Cookie', 'X-Content-Type-Options': 'nosniff' }
export interface WireRequest { url: string, method: string, headers: Headers, body?: ReadableStream<Uint8Array> | null }
export type IncidentRequest = WireRequest & { getParam: (name: string) => string | undefined }
export function readBody(request: WireRequest, limit: number) {
  return readJsonBody(new Request(request.url, { method: request.method, headers: request.headers, body: request.body ?? null }), limit)
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value)
  const deadline = managedDownloadDeadline(response)
  // The final application clone can follow awaited middleware after the binary Action.
  if (deadline !== undefined && (!Number.isFinite(deadline) || Date.now() >= deadline)) return failure(new PublicSafetyAccessError(404, 'Incident is unavailable'))
  const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  return deadline === undefined ? result : associateManagedDownload(result, deadline)
}
export function failure(error: unknown): Response {
  if (error instanceof PublicSafetyAccessError || error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders })
  return Response.json({ error: 'Incident request failed' }, { status: 500, headers: privateHeaders })
}
/** Wrap native auth and CSRF as well as Actions, without exposing framework diagnostics. */
export async function incidentHttpBoundary(request: Request, next: () => Promise<Response | null> | Response | null) {
  const path = new URL(request.url).pathname
  if (path !== '/api/public-safety/incidents' && !path.startsWith('/api/public-safety/incidents/')) return next()
  let result: Response | null
  try { result = await next() }
  catch (error) { result = await createMiddlewareErrorResponse(error instanceof Error ? error : new Error('Incident request failed'), request) }
  if (!result) return result
  if (result.status >= 400) return Response.json({ error: result.status === 401 ? 'A valid incident access token is required' : result.status === 403 ? 'This incident action is not permitted' : result.status === 404 ? 'Incident is unavailable' : result.status === 409 ? 'Incident state conflicts with this request' : result.status === 413 ? 'Request body is too large' : result.status === 415 ? 'Content-Type must be application/json' : result.status === 422 ? 'Invalid incident request' : result.status === 400 ? 'Invalid incident JSON' : 'Incident request failed' }, { status: result.status, headers: privateHeaders })
  return privateResponse(result)
}
export async function execute(work: () => Promise<unknown>, status = 200): Promise<Response> {
  try { return Response.json(await work(), { status, headers: privateHeaders }) }
  catch (error) { return failure(error) }
}
export function createIncidentHttp(request: WireRequest) {
  return execute(async () => { await authorizePublicSafetyCreate(); return createPublicSafetyIncident(await readBody(request, 256 * 1024)) }, 201)
}
export function readIncidentHttp(request: IncidentRequest) {
  return execute(() => readPublicSafetyIncident(request.getParam('incident') ?? ''))
}
export function changeIncidentMembershipHttp(request: IncidentRequest) {
  return execute(async () => { const key = request.getParam('incident') ?? ''; await authorizePublicSafetyIncident(key, 'manage-members'); return changePublicSafetyMembership(key, await readBody(request, 8 * 1024)) })
}
export function closeIncidentHttp(request: IncidentRequest) {
  return execute(async () => { const key = request.getParam('incident') ?? ''; await authorizePublicSafetyIncident(key, 'close'); return closePublicSafetyIncident(key, await readBody(request, 8 * 1024)) })
}
export function auditIncidentHttp(request: IncidentRequest) {
  return execute(async () => {
    const key = request.getParam('incident') ?? ''
    await authorizePublicSafetyIncident(key, 'audit')
    const query = new URL(request.url).searchParams
    if ([...query.keys()].some(name => name !== 'after' && name !== 'limit') || query.getAll('after').length > 1 || query.getAll('limit').length > 1) throw new PublicSafetyAccessError(422, 'Invalid audit pagination')
    const integer = (name: string, fallback: number, min: number, max: number) => {
      const value = query.get(name)
      if (value === null) return fallback
      if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new PublicSafetyAccessError(422, 'Invalid audit pagination')
      return Number(value)
    }
    return readPublicSafetyAudit(key, { afterSequence: integer('after', 0, 0, 2147483647), limit: integer('limit', 100, 1, 100) })
  })
}
