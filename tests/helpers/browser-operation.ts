import { writeSync } from 'node:fs'

export type BrowserControlAction = 'status' | 'release' | 'verify' | 'read-only' | 'revoke'
type BrowserOperation = 'version-fetch' | 'version-json' | 'browser-socket' | 'target-fetch' | 'target-json' | 'page-socket' | `control-${BrowserControlAction}-${'fetch' | 'json'}`

/** Observe an owned transport boundary without replacing its result, error or timeout. */
export async function observeBrowserOperation<T>(operation: BrowserOperation, work: () => Promise<T>): Promise<T> {
  const began = performance.now()
  try { return await work() }
  catch (error) {
    // Reporting is best effort. A closed diagnostic pipe must preserve the native error.
    try {
      const phase = operation.startsWith('version-') || operation === 'browser-socket' ? 'browser-start' : operation.startsWith('control-') ? 'workspace-control' : 'page-open'
      const nativeError = error instanceof Error && ['TimeoutError', 'AbortError', 'SyntaxError'].includes(error.name) ? error.name : 'other'
      const bytes = new TextEncoder().encode(`${JSON.stringify({ oracle: 'browser-operation-failure', phase, operation, nativeError, elapsedMs: performance.now() - began })}\n`)
      const report = (descriptor: number) => {
        try { return writeSync(descriptor, bytes) === bytes.byteLength }
        catch { return false }
      }
      if (!report(2)) report(1)
    }
    catch {}
    throw error
  }
}
