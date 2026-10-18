import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { MissionTrace } from './engine'
import { missionLimits, parseMissionTrace } from './engine'
/** Private local simulation artifacts only. No application storage or hardware transport is opened. */
export async function readMissionFile(path: string, options: { preserveBom?: boolean } = {}): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > missionLimits.bytes) throw new RangeError('Mission file must be a regular file up to 8 MiB')
    const buffer = new Uint8Array(missionLimits.bytes + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null)
      if (bytesRead === 0) break
      used += bytesRead
    }
    if (used > missionLimits.bytes) throw new RangeError('Mission file exceeds 8 MiB')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: options.preserveBom ?? false }).decode(buffer.subarray(0, used))
  }
  finally { await file.close() }
}
export async function writeMissionTrace(directory: string, trace: MissionTrace): Promise<string> {
  const text = JSON.stringify(trace)
  // Recompute before persistence. A completed write remains an unsigned simulator artifact.
  parseMissionTrace(`${text}\n`)
  const root = resolve(directory)
  await mkdir(root, { mode: 0o700 })
  const path = resolve(root, 'mission.json')
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(`${text}\n`); await file.sync() }
  finally { await file.close() }
  return path
}
