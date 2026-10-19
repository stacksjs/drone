import type { IncidentRequest } from '../access/http'
import type { ManagedListOptions } from './types'
import { PublicSafetyAccessError } from '../access/errors'
import { execute, failure, privateHeaders, readBody } from '../access/http'
import { authorizePublicSafetyManaged } from './policy'
import { associateManagedDownload } from './download-deadline'
import { createPublicSafetyManagedDataset, listPublicSafetyManagedArtifacts, readPublicSafetyManagedArtifact, readPublicSafetyManagedArtifactFile, listPublicSafetyManagedArtifactEvents, reconcilePublicSafetyManagedArtifact } from './service'

function query(request: IncidentRequest, allowed: readonly string[]): URLSearchParams {
  const values = new URL(request.url).searchParams
  for (const name of values.keys()) if (!allowed.includes(name) || values.getAll(name).length !== 1) throw new PublicSafetyAccessError(422, 'Invalid managed dataset query')
  return values
}
function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value || Number(value) < min || Number(value) > max) throw new PublicSafetyAccessError(422, 'Invalid managed dataset cursor')
  return Number(value)
}
function incident(request: IncidentRequest): string { return request.getParam('incident') ?? '' }
function artifact(request: IncidentRequest): string { return request.getParam('artifact') ?? '' }

export async function createManagedDatasetHttp(request: IncidentRequest): Promise<Response> {
  try {
    const key = incident(request)
    await authorizePublicSafetyManaged(key, 'create')
    query(request, [])
    const receipt = await createPublicSafetyManagedDataset(key, await readBody(request, 8192))
    return Response.json(receipt, { status: receipt.replayed ? 200 : receipt.artifact.state === 'complete' ? 201 : 202, headers: privateHeaders })
  }
  catch (error) { return failure(error) }
}
export function listManagedArtifactsHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = incident(request)
    await authorizePublicSafetyManaged(key, 'read')
    const values = query(request, ['afterId', 'limit', 'requestId'])
    let options: ManagedListOptions
    if (values.has('requestId')) {
      if (values.has('afterId') || values.has('limit')) throw new PublicSafetyAccessError(422, 'Request lookup cannot use pagination')
      options = { requestId: values.get('requestId')! }
    }
    else options = { afterId: integer(values.get('afterId'), 0, 0, 2147483647), limit: integer(values.get('limit'), 100, 1, 100) }
    return listPublicSafetyManagedArtifacts(key, options)
  })
}
export function readManagedArtifactHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = incident(request)
    await authorizePublicSafetyManaged(key, 'read')
    query(request, [])
    return readPublicSafetyManagedArtifact(key, artifact(request))
  })
}
export function listManagedArtifactEventsHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = incident(request)
    await authorizePublicSafetyManaged(key, 'events')
    const values = query(request, ['after', 'limit'])
    return listPublicSafetyManagedArtifactEvents(key, artifact(request), { afterSequence: integer(values.get('after'), 0, 0, 2147483647), limit: integer(values.get('limit'), 100, 1, 100) })
  })
}
export function reconcileManagedArtifactHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = incident(request)
    await authorizePublicSafetyManaged(key, 'reconcile')
    query(request, [])
    return reconcilePublicSafetyManagedArtifact(key, artifact(request), await readBody(request, 8192))
  })
}
export async function readManagedArtifactFileHttp(request: IncidentRequest): Promise<Response> {
  try {
    const key = incident(request)
    await authorizePublicSafetyManaged(key, 'read')
    query(request, [])
    const id = integer(request.getParam('file') ?? '', 0, 1, 2147483647)
    const download = await readPublicSafetyManagedArtifactFile(key, artifact(request), id)
    const allowedMime = ['application/json', 'image/png', 'application/octet-stream', 'text/plain; charset=utf-8']
    if (!allowedMime.includes(download.mimeType) || download.filename.match(/^[a-z0-9._-]{1,128}$/i)?.[0] !== download.filename || download.filename === '.' || download.filename === '..' || download.bytes.byteLength > 32 * 1024 * 1024) throw new PublicSafetyAccessError(409, 'Managed dataset file is unavailable')
    // Native negotiation can encode these already verified bytes and remove the source length.
    const headers = { ...privateHeaders, 'Content-Type': download.mimeType, 'Content-Length': String(download.bytes.byteLength), 'Content-Disposition': `attachment; filename="${download.filename}"` }
    const body = request.method === 'HEAD' ? null : new Uint8Array(download.bytes)
    const deadline = Date.parse(download.retainUntil)
    // No await or supplied callback after the final service result and this release-time check.
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new PublicSafetyAccessError(404, 'Incident is unavailable')
    return associateManagedDownload(new Response(body, { status: 200, headers }), deadline)
  }
  catch (error) { return failure(error) }
}
