import type { IncidentRequest } from '../access/http'
import type { WorkspaceOptions } from './types'
import { Gate } from '@stacksjs/auth/gate'
import { PublicSafetyAccessError } from '../access/errors'
import { execute, failure } from '../access/http'
import { requirePublicSafetyPrincipal } from '../access/principal'
import { readIncidentWorkspace } from './service'
import { captureWorkspaceCheck, openIncidentWorkspaceStream } from './stream'

const keys = ['sourceDigest', 'sourcesAfterSequence', 'contextCursor', 'offerKey', 'handoverAfterSequence', 'membersAfterUserId', 'limit'] as const
async function authorize(key: string): Promise<void> {
  const principal = await requirePublicSafetyPrincipal('read')
  if (!await Gate.allows('public-safety:workspace-read', principal.user, key)) throw new PublicSafetyAccessError(403, 'This workspace action is not permitted')
}
function options(request: IncidentRequest, events: boolean): WorkspaceOptions {
  const url = new URL(request.url)
  const length = request.headers.get('content-length')
  // Bun may expose a GET body as null; reject its wire framing without reading it.
  if (url.search.length > 4096 || request.body || request.headers.has('transfer-encoding') || length !== null && length !== '0') throw new PublicSafetyAccessError(422, 'Invalid workspace request')
  const values = url.searchParams
  if ([...values.keys()].some(name => events || !keys.includes(name as typeof keys[number]) || values.getAll(name).length !== 1)) throw new PublicSafetyAccessError(422, 'Invalid workspace options')
  const result: Record<string, string | number> = {}
  for (const [key, value] of values) {
    if (['sourcesAfterSequence', 'handoverAfterSequence', 'membersAfterUserId', 'limit'].includes(key)) {
      const maximum = key === 'membersAfterUserId' ? Number.MAX_SAFE_INTEGER : key === 'limit' ? 100 : 2147483647
      if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value || Number(value) > maximum || key === 'limit' && Number(value) < 1) throw new PublicSafetyAccessError(422, 'Invalid workspace cursor')
      result[key] = Number(value)
    }
    else result[key] = value
  }
  return result
}
export function readWorkspaceHttp(request: IncidentRequest): Promise<Response> {
  return execute(async () => {
    const key = request.getParam('incident') ?? ''
    await authorize(key)
    return readIncidentWorkspace(key, options(request, false))
  })
}
export async function streamWorkspaceHttp(request: IncidentRequest & { signal: AbortSignal }): Promise<Response> {
  try {
    const key = request.getParam('incident') ?? ''
    const check = captureWorkspaceCheck(key)
    await authorize(key)
    options(request, true)
    return await openIncidentWorkspaceStream(check, request.signal, request.method === 'HEAD')
  }
  catch (error) { return failure(error) }
}
