import type { CameraSnapshot } from './types'

export async function cameraRequest(token: string, command?: Record<string, unknown>): Promise<CameraSnapshot> {
  const response = await fetch(command ? '/api/camera/command' : '/api/camera/state', {
    method: command ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    ...(command ? { body: JSON.stringify(command) } : {}),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error ?? `Camera request failed (${response.status})`)
  return payload as CameraSnapshot
}
