import type { PayloadCaptureResult } from './capture'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { jpegDimensions } from './capture'
import { payloadJson } from './bench'
/** Exclusive new local directory. JSON is the completion marker; incomplete directories are retained for diagnosis. */
export async function savePayloadCapture(capture: PayloadCaptureResult, directory: string) {
  const snapshot = structuredClone(capture), jpeg = snapshot.jpeg, dimensions = jpegDimensions(jpeg)
  if (createHash('sha256').update(jpeg).digest('hex') !== snapshot.sha256 || jpeg.length !== snapshot.byteLength || dimensions.width !== snapshot.camera.width || dimensions.height !== snapshot.camera.height) throw new TypeError('Capture image and manifest disagree')
  const target = resolve(directory)
  await mkdir(target, { mode: 0o700 })
  await writeFile(join(target, 'capture.jpg'), jpeg, { flag: 'wx', mode: 0o600 })
  await writeFile(join(target, 'capture.json'), `${payloadJson(snapshot)}\n`, { flag: 'wx', mode: 0o600 })
  return { directory: target, image: join(target, 'capture.jpg'), manifest: join(target, 'capture.json'), sha256: snapshot.sha256 }
}
