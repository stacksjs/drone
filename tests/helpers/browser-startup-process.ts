import { browserFileErrorCode } from './browser-launch-evidence'
import type { createLinuxStartupObservation } from './browser-startup-linux'

type NativeSnapshot = Awaited<ReturnType<ReturnType<typeof createLinuxStartupObservation>['snapshot']>>
export interface StartupProcessAdapter {
  snapshot: (signal: AbortSignal) => Promise<NativeSnapshot | { status: 'unavailable', code: string | null }>
  settleExecutables: (hash: boolean) => Promise<void>
  evidence: ReturnType<typeof createLinuxStartupObservation>['evidence']
}

type Probe = 'present' | 'missing' | 'denied' | 'unavailable'
function rootProbe(pid: number): Probe {
  try { process.kill(pid, 0); return 'present' }
  catch (error) {
    const code = browserFileErrorCode(error)
    return code === 'ESRCH' ? 'missing' : code === 'EPERM' ? 'denied' : 'unavailable'
  }
}

/** Startup-only facts. A PID probe does not establish complete process-group ownership. */
export function createBrowserStartupObserver(pid: number, began: number, linux: StartupProcessAdapter | null) {
  type Linux = NativeSnapshot | { status: 'unsupported' | 'timeout' | 'unavailable', code: string | null }
  const snapshots: Array<{ label: string, elapsedMs: number, completedAtMs: number, root: { pid: number, probe: Probe }, linux: Linux }> = []
  const milestones = [0, 1000, 5000, 10000, 15000]
  let next = 0, sealed = false, inFlight = false, canceled = false, browserVersion: string | null = null
  const sample = async (label: string) => {
    const elapsedMs = performance.now() - began, root = { pid, probe: rootProbe(pid) }
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, expired = false
    try {
      let observation: Linux = { status: 'unsupported', code: null }
      if (linux && canceled) observation = { status: 'unavailable', code: 'OBSERVATION_CANCELED' }
      else if (linux) {
        timer = setTimeout(() => {
          expired = true; canceled = true; abort.abort()
          console.error(JSON.stringify({ oracle: 'browser-startup-observation-pending', pid, elapsedMs: performance.now() - began }))
        }, 500)
        // Cancellation requests are not settlement. Own this actual task until it returns.
        observation = await linux.snapshot(abort.signal).catch(error => ({ status: 'unavailable' as const, code: browserFileErrorCode(error) }))
        if (expired) observation = { status: 'timeout', code: 'OBSERVATION_BUDGET' }
      }
      snapshots.push({ label, elapsedMs, completedAtMs: performance.now() - began, root, linux: observation })
    }
    finally { if (timer) clearTimeout(timer) }
  }
  let pending: Promise<void> = Promise.resolve()
  return {
    tick() {
      if (!sealed && !canceled && !inFlight && next < milestones.length && performance.now() - began >= milestones[next]!) {
        const at = milestones[next++]!
        inFlight = true
        pending = sample(at === 0 ? 'launch' : `elapsed-${at}ms`).finally(() => { inFlight = false })
      }
    },
    async finishDiscovery() { sealed = true; await pending; await sample('discovery-ended'); await linux?.settleExecutables(!canceled) },
    async cleanupEnded() { await sample('cleanup-ended') },
    recordVersion(value: unknown) { if (typeof value === 'string' && /^(?:HeadlessChrome|Chrome)\/\d{1,6}(?:\.\d{1,8}){3}$/.test(value)) browserVersion = value },
    evidence() { return { method: 'startup-only-process-observation-v1' as const, platform: process.platform, browserVersion, snapshots: structuredClone(snapshots), ...linux?.evidence() ?? { executables: [], identityErrors: [], executableLimitReached: false } } },
  }
}
export type BrowserStartupEvidence = ReturnType<ReturnType<typeof createBrowserStartupObserver>['evidence']>
