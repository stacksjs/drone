import { Buffer } from 'node:buffer'
import { writeSync } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface BrowserLaunchObservation {
  phase: 'startup-unavailable' | 'discovery-failed' | 'closed'
  elapsedMs: number
  launch: { pid: number, exitObserved: boolean, settledExitCode: number | null, signalCode: string | number | null, exitObservedBeforeCleanup: boolean, cleanupRequested: boolean, exitElapsedMs: number | null }
  portProbe: { attempts: number, successfulReads: number, failedReads: number, lastReadError: string | null, discovered: boolean }
}
export function browserFileErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'OTHER'
}
function unavailable(target: 'local' | 'export', error: unknown) {
  const bytes = new TextEncoder().encode(`${JSON.stringify({ oracle: 'browser-launch-evidence-unavailable', target, code: browserFileErrorCode(error) })}\n`)
  for (const descriptor of [2, 1]) {
    try { if (writeSync(descriptor, bytes) === bytes.byteLength) return }
    catch { /* Reporting must preserve the original browser failure. */ }
  }
}
/** Public stderr is captured only before any page can receive native fixture credentials. */
export async function retainBrowserLaunchEvidence(root: string, observation: BrowserLaunchObservation, options: { startupStderr: boolean, exportDirectory?: string }) {
  let stderr: { status: 'retained' | 'unavailable' | 'withheld', retainedBytes: number, totalBytes: number | null, truncated: boolean, code: string | null } = { status: 'withheld', retainedBytes: 0, totalBytes: null, truncated: false, code: null }
  let retained: Buffer | undefined
  if (options.startupStderr) {
    try {
      const handle = await open(join(root, 'chrome.log'), 'r')
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) throw new Error('Startup stderr is not a regular file')
        const size = Math.min(stat.size, 65536), bytes = Buffer.alloc(size)
        const { bytesRead } = await handle.read(bytes, 0, size, Math.max(0, stat.size - size))
        retained = bytes.subarray(0, bytesRead)
        stderr = { status: 'retained', retainedBytes: bytesRead, totalBytes: stat.size, truncated: stat.size > bytesRead, code: null }
      }
      finally { await handle.close() }
    }
    catch (error) { stderr = { status: 'unavailable', retainedBytes: 0, totalBytes: null, truncated: false, code: browserFileErrorCode(error) } }
  }
  const outcomes = { local: false, export: false }
  for (const target of ['local', 'export'] as const) {
    const directory = target === 'local' ? root : options.exportDirectory
    if (!directory) continue
    try {
      if (target === 'export') await mkdir(directory, { recursive: true })
      let snapshot = stderr
      if (retained) {
        try { await writeFile(join(directory, 'chrome-startup-stderr.log'), retained, { mode: 0o600 }) }
        catch (error) { snapshot = { ...stderr, status: 'unavailable', retainedBytes: 0, code: browserFileErrorCode(error) } }
      }
      await writeFile(join(directory, 'browser-launch.json'), `${JSON.stringify({ version: 1, evidence: 'owned-browser-launch-observation', ...observation, stderr: snapshot }, null, 2)}\n`, { mode: 0o600 })
      outcomes[target] = true
    }
    catch (error) { unavailable(target, error) }
  }
  return outcomes
}
