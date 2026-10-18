import { timingSafeEqual } from 'node:crypto'
import { readJsonBody, RequestBodyError } from '@stacksjs/router'
import { cameraSession } from './session'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
interface CameraRequest { headers: Headers, body?: ReadableStream<Uint8Array> | null }

/** Stateless bearer authorization. No cookies, ambient development bypass or query-string tokens. */
export function authorizeCamera(request: Pick<CameraRequest, 'headers'>, secret = process.env.DRONE_CAMERA_TOKEN): Response | undefined {
  if (!secret || secret.length < 32) return Response.json({ error: 'Configure DRONE_CAMERA_TOKEN with at least 32 characters on the server' }, { status: 503, headers })
  const supplied = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`
  const suppliedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  if (suppliedBytes.length > 512 || suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes))
    return Response.json({ error: 'Camera operator authorization required' }, { status: 401, headers })
}

export function cameraState(request: Pick<CameraRequest, 'headers'>): Response {
  return authorizeCamera(request) ?? Response.json(cameraSession().snapshot(), { headers })
}

export function applyCameraCommand(input: unknown, session = cameraSession()): CameraCommandResult {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid camera command')
  const body = input as Record<string, unknown>
  if (body.command === 'start' && (body.source === 'replay' || body.source === 'imx500')) return session.start(body.source)
  if (body.command === 'stop') return session.stop()
  if (body.command === 'clear') return session.clear()
  if (body.command === 'select' && typeof body.candidateId === 'string' && body.candidateId.length <= 64
    && Number.isSafeInteger(body.sequence) && typeof body.sessionId === 'string' && body.sessionId.length <= 64)
    return session.select(body.candidateId, Number(body.sequence), body.sessionId)
  if (body.command === 'inject' && (body.fault === 'none' || body.fault === 'loss' || body.fault === 'ambiguity')) return session.inject(body.fault)
  throw new TypeError('Unsupported camera command')
}
type CameraCommandResult = ReturnType<ReturnType<typeof cameraSession>['snapshot']>

export async function cameraCommand(request: CameraRequest): Promise<Response> {
  const denied = authorizeCamera(request)
  if (denied) return denied
  try {
    const wireRequest = new Request('http://camera.internal/command', { method: 'POST', headers: request.headers, body: request.body ?? null })
    const body = await readJsonBody(wireRequest, 2048)
    return Response.json(applyCameraCommand(body), { headers })
  }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Camera command failed' }, { status: error instanceof RequestBodyError ? error.status : 422, headers })
  }
}
