import { resolve } from 'node:path'
import { openCameraPayloadProcess } from './process'
import { PayloadCaptureError } from './types'
/** Exclusive still-camera acquisition. Stop the tracking camera session before opening this adapter. */
export async function openPiAiCameraPayload(options: { project?: string } = {}) {
  if (process.platform !== 'linux') throw new PayloadCaptureError('device', 'Pi AI Camera capture requires Linux on the Pi')
  const worker = resolve(options.project ?? process.cwd(), 'resources/functions/drone/camera/imx500_worker.py')
  if (!await Bun.file(worker).exists()) throw new PayloadCaptureError('device', 'Camera worker unavailable; select the project directory')
  return openCameraPayloadProcess({ command: [process.env.DRONE_CAMERA_PYTHON ?? '/usr/bin/python3', '-u', worker, '--payload'], evidence: 'hardware' })
}
