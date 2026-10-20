import { createMiddlewareErrorResponse, readJsonBody, RequestBodyError } from '@stacksjs/router'
import { PatrolReviewError, routeDue, isPatrolDatabaseBusy } from './contract'
import { authorizePatrol } from './policy'
import { createPatrolReviewSchedule, readPatrolReviewSchedule, decidePatrolReview, consumePatrolReview } from './service'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8' }
const messages: Record<number, string> = { 401: 'A valid patrol access token is required', 403: 'This patrol action is not permitted', 404: 'Patrol review is unavailable', 409: 'Patrol review conflicts with this request', 413: 'Request body is too large', 415: 'Content-Type must be application/json', 400: 'Invalid patrol JSON', 422: 'Invalid patrol request', 503: 'Patrol review is temporarily unavailable', 500: 'Patrol request failed' }
const failure = (status: number) => new Response(`${JSON.stringify({ error: messages[status] ?? messages[500] })}\n`, { status: messages[status] ? status : 500, headers })
type WireRequest = { url: string, method: string, headers: Headers, body?: ReadableStream<Uint8Array> | null, getParam: (name: string) => string | undefined }
export async function patrolHttpBoundary(request: Request, next: () => Response | null | Promise<Response | null>) {
  const path = new URL(request.url).pathname
  if (path !== '/api/patrol/reviews' && !path.startsWith('/api/patrol/reviews/')) return next()
  let result: Response | null
  try { result = await next() }
  catch (error) { result = await createMiddlewareErrorResponse(error instanceof Error ? error : new Error('Patrol request failed'), request) }
  if (!result) return result
  if (result.status >= 400) return failure(result.status)
  if (result.status >= 300) return failure(401)
  const outputHeaders = new Headers(result.headers)
  for (const [key, value] of Object.entries(headers)) outputHeaders.set(key, value)
  return new Response(result.body, { status: result.status, headers: outputHeaders })
}
async function execute(work: () => Promise<unknown>, created = false) {
  try {
    const value = await work()
    const replayed = !!value && typeof value === 'object' && 'replayed' in value && value.replayed === true
    return new Response(`${JSON.stringify(value)}\n`, { status: created && !replayed ? 201 : 200, headers })
  }
  catch (error) { return failure(error instanceof PatrolReviewError || error instanceof RequestBodyError ? error.status : isPatrolDatabaseBusy(error) ? 503 : 500) }
}
export function createPatrolReviewHttp(request: WireRequest) {
  return execute(async () => {
    await authorizePatrol('create')
    const body = await readJsonBody(new Request(request.url, { method: request.method, headers: request.headers, body: request.body ?? null }), 8192)
    return createPatrolReviewSchedule(body)
  }, true)
}
export function readPatrolReviewHttp(request: WireRequest) {
  return execute(async () => {
    await authorizePatrol('read')
    if (new URL(request.url).search) throw new PatrolReviewError(422)
    return readPatrolReviewSchedule(request.getParam('schedule') ?? '')
  })
}

export function decidePatrolReviewHttp(request: WireRequest) {
  return execute(async () => {
    await authorizePatrol('review')
    const body = await readJsonBody(new Request(request.url, { method: request.method, headers: request.headers, body: request.body ?? null }), 8192)
    let due: number
    try { due = routeDue(request.getParam('due') ?? '') }
    catch { throw new PatrolReviewError(422) }
    if (new URL(request.url).search) throw new PatrolReviewError(422)
    return decidePatrolReview(request.getParam('schedule') ?? '', due, body)
  })
}

export function consumePatrolReviewHttp(request: WireRequest) {
  return execute(async () => {
    await authorizePatrol('consume')
    const body = await readJsonBody(new Request(request.url, { method: request.method, headers: request.headers, body: request.body ?? null }), 8192)
    let due: number
    try { due = routeDue(request.getParam('due') ?? '') }
    catch { throw new PatrolReviewError(422) }
    if (new URL(request.url).search) throw new PatrolReviewError(422)
    return consumePatrolReview(request.getParam('schedule') ?? '', due, body)
  })
}
