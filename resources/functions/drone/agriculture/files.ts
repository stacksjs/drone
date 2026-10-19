import { readMissionFile } from '../missions/files'
import { parseAgricultureRecording } from './evidence'

export async function readAgricultureConfig(path: string): Promise<unknown> {
  try { return JSON.parse(await readMissionFile(path)) }
  catch { throw new TypeError('Invalid agriculture configuration JSON or file') }
}
export async function readAgricultureRecording(path: string) {
  return parseAgricultureRecording(await readMissionFile(path, { maxBytes: 16 * 1024 * 1024 }))
}
export async function readAgricultureObservations(path: string): Promise<unknown> {
  try { return JSON.parse(await readMissionFile(path)) }
  catch { throw new TypeError('Invalid retained livestock observations JSON or file') }
}
