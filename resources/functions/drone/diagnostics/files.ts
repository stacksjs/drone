import { constants } from 'node:fs'
import { open, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { diagnosticLimits } from './types'
import { hashDiagnostic, parseDiagnosticsJournal } from './journal'

/** Bounded regular-file read. No symlink traversal at the final component and no devices/pipes. */
export async function readDiagnosticsFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > diagnosticLimits.fileBytes) throw new TypeError('Select a regular diagnostic file up to 4 MiB')
    const bytes = new Uint8Array(diagnosticLimits.fileBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > diagnosticLimits.fileBytes) throw new RangeError('Diagnostic file grew beyond 4 MiB')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
  }
  finally { await file.close() }
}
/** Export only complete, verified, schema-checked records. A crash tail is discarded and remains marked unfinalized. */
export async function exportDiagnostics(inputPath: string, outputDirectory: string) {
  const text = await readDiagnosticsFile(inputPath)
  const journal = await parseDiagnosticsJournal(text)
  const verified = `${[journal.header, ...journal.events, ...(journal.footer ? [journal.footer] : [])].map(row => JSON.stringify(row)).join('\n')}\n`
  const directory = resolve(outputDirectory)
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, 'journal.ndjson')
  await writeFile(path, verified, { mode: 0o600, flag: 'wx' })
  return { path, sha256: await hashDiagnostic(verified), completion: journal.completion, loss: journal.loss, discardedTailBytes: journal.discardedTailBytes }
}
