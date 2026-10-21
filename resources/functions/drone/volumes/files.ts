import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

/** Bounded local bytes. Parent paths remain caller-owned; concurrent writes are not atomic. */
export async function readGeoTiffFile(path: string): Promise<Uint8Array> {
  try {
    if (typeof path !== 'string' || !Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0 || !Number.isSafeInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0) throw new Error()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const limit = 8 * 1024 * 1024, stat = await file.stat()
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limit) throw new Error()
      const bytes = new Uint8Array(limit + 1)
      let used = 0
      while (used < bytes.length) {
        const { bytesRead } = await file.read(bytes, used, bytes.length - used, null)
        if (bytesRead === 0) break
        used += bytesRead
      }
      if (used > limit) throw new Error()
      return bytes.slice(0, used)
    }
    finally { await file.close() }
  }
  catch { throw new Error('geotiff-file-unavailable') }
}
