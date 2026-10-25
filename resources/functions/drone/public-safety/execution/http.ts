import type { IncidentRequest } from '../access/http'
import type { ExecutionContext } from './policy'
import type { ExecutionStartInput, ExecutionLocator, ExecutionAdmissionInput } from './types'
import { readTextBody, RequestBodyError } from '@stacksjs/router'
import { parseJsonText } from '@stacksjs/router/json'
import { PublicSafetyAccessError } from '../access/errors'
import { failure, privateHeaders } from '../access/http'
import { associateIncidentDeadline, assertIncidentDeadline, incidentDeadline } from '../access/deadline'
import { authorizePublicSafetyIncident } from '../access/service'
import { readWorkspaceAccess } from '../workspace/policy'
import { captureExecutionContext, startIncidentExecution, readIncidentExecution, closeIncidentExecution, admitIncidentExecution } from './service'
import { runExecutionCheck } from './policy'
import { openIncidentExecutionStream } from './stream'

/** Coarse body admission only. Every operation still runs its full fresh core policy. */
async function preflight(context: ExecutionContext): Promise<number> {
  return runExecutionCheck(context, async () => {
    await authorizePublicSafetyIncident(context.key, 'view')
    await authorizePublicSafetyIncident(context.key, 'source-register')
    return (await readWorkspaceAccess(context.key)).deadline
  })
}
function query(request: IncidentRequest, reading: boolean): string | undefined {
  const url = new URL(request.url)
  if (url.search.length > 4096) throw new PublicSafetyAccessError(422, 'Invalid execution query')
  const entries = [...url.searchParams]
  if (!reading) {
    if (entries.length) throw new PublicSafetyAccessError(422, 'Invalid execution query')
    return undefined
  }
  const length = request.headers.get('content-length')
  if (request.body || request.headers.has('transfer-encoding') || length !== null && length !== '0') throw new PublicSafetyAccessError(422, 'Invalid execution request')
  if (entries.length !== 1 || entries[0]![0] !== 'scope' || !/^[a-f0-9]{64}$/.test(entries[0]![1])) throw new PublicSafetyAccessError(422, 'Invalid execution query')
  return entries[0]![1]
}
function execution(request: IncidentRequest): string {
  const value = request.getParam('execution') ?? ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new PublicSafetyAccessError(422, 'Invalid execution locator')
  return value
}
async function body(request: IncidentRequest): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new RequestBodyError('Content-Type must be application/json', 415)
  const text = await readTextBody(new Request(request.url, { method: request.method, headers: request.headers, body: request.body ?? null }), 8192)
  try { return parseJsonText(text, { rejectDuplicateKeys: true }) }
  catch { throw new RequestBodyError('Send valid UTF-8 JSON', 400) }
}
function json(value: unknown, deadline: number, status = 200, head = false): Response {
  assertIncidentDeadline(value)
  const response = associateIncidentDeadline(head ? new Response(null, { status, headers: privateHeaders }) : Response.json(value, { status, headers: privateHeaders }), Math.min(deadline, incidentDeadline(value) ?? Number.POSITIVE_INFINITY))
  assertIncidentDeadline(response)
  return response
}
export async function startExecutionHttp(request: IncidentRequest, workerUrl: URL): Promise<Response> {
  try {
    const context = captureExecutionContext(request.getParam('incident') ?? '')
    const deadline = await preflight(context)
    query(request, false)
    return json(await startIncidentExecution(context, await body(request) as ExecutionStartInput, workerUrl), deadline, 202)
  }
  catch (error) { return failure(error) }
}
export async function readExecutionHttp(request: IncidentRequest): Promise<Response> {
  try {
    const context = captureExecutionContext(request.getParam('incident') ?? '')
    const deadline = await preflight(context)
    const scope = query(request, true)!
    return json(await readIncidentExecution(context, { scope }), deadline, 200, request.method === 'HEAD')
  }
  catch (error) { return failure(error) }
}
export async function closeExecutionHttp(request: IncidentRequest): Promise<Response> {
  try {
    const context = captureExecutionContext(request.getParam('incident') ?? '')
    const deadline = await preflight(context)
    query(request, false)
    return json(await closeIncidentExecution(context, await body(request) as ExecutionLocator), deadline)
  }
  catch (error) { return failure(error) }
}
export async function admitExecutionHttp(request: IncidentRequest): Promise<Response> {
  try {
    const context = captureExecutionContext(request.getParam('incident') ?? '')
    const deadline = await preflight(context)
    query(request, false)
    return json(await admitIncidentExecution(context, await body(request) as ExecutionAdmissionInput), deadline, 201)
  }
  catch (error) { return failure(error) }
}
export async function streamExecutionHttp(request: IncidentRequest & { signal: AbortSignal }): Promise<Response> {
  try {
    const context = captureExecutionContext(request.getParam('incident') ?? '')
    const deadline = await preflight(context)
    const locator = { execution: execution(request), scope: query(request, true)! }
    // HEAD performs the same native owner read without reserving a subscriber.
    if (request.method === 'HEAD') {
      const value = await readIncidentExecution(context, { scope: locator.scope })
      if (!value || value.execution !== locator.execution) throw new PublicSafetyAccessError(404, 'Execution is unavailable')
      const response = json(value, deadline, 200, true)
      response.headers.set('Content-Type', 'text/event-stream')
      response.headers.set('X-Accel-Buffering', 'no')
      return response
    }
    return await openIncidentExecutionStream(context, locator, request.signal, deadline)
  }
  catch (error) { return failure(error) }
}
