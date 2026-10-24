import { expect, test } from 'bun:test'
import { mkdtemp, readlink, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserStartupObserver } from '../helpers/browser-startup-process'
import type { StartupProcessAdapter } from '../helpers/browser-startup-process'
import { createLinuxStartupObservation } from '../helpers/browser-startup-linux'

// OS adapter seam: a held syscall promise checks ownership/cancellation, not Linux field acquisition.
test('an expired observation remains owned through actual settlement and prevents later provider work', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0, active = 0, maximumActive = 0, finalized = false
  const settlements: boolean[] = []
  const adapter: StartupProcessAdapter = {
    async snapshot() {
      calls++; active++; maximumActive = Math.max(maximumActive, active)
      try { if (calls === 1) await held; return { status: 'unavailable', code: 'CONTROLLED_OS' } }
      finally { active-- }
    },
    async settleExecutables(hash) { expect(active).toBe(0); settlements.push(hash) },
    evidence: () => ({ executables: [], identityErrors: [], executableLimitReached: false }),
  }
  const observer = createBrowserStartupObserver(process.pid, performance.now() - 1001, adapter)
  let finishing: Promise<void> | undefined
  try {
    observer.tick()
    await Bun.sleep(600)
    observer.tick()
    expect(calls).toBe(1)
    finishing = observer.finishDiscovery().then(() => { finalized = true })
    await Bun.sleep(10)
    expect(finalized).toBe(false)
    expect(settlements).toEqual([])
    release(); await finishing
    expect(maximumActive).toBe(1)
    expect(calls).toBe(1)
    expect(settlements).toEqual([false])
    const final = observer.evidence()
    observer.tick(); await Bun.sleep(10)
    expect(observer.evidence()).toEqual(final)
    expect(final.snapshots[0]!.linux.status).toBe('timeout')
    expect(final.snapshots[0]!.completedAtMs).toBeGreaterThan(final.snapshots[0]!.elapsedMs + 500)
  }
  finally { release(); await finishing; await Bun.sleep(0) }
})

test.skipIf(process.platform !== 'linux')('cancellation closes actual pinned executable descriptors without hashing after the held native sample settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-observer-descriptors-'))
  const executable = await readlink('/proc/self/exe')
  const descriptors = async () => {
    const ids = await readdir('/proc/self/fd')
    const targets = await Promise.all(ids.map(id => readlink(`/proc/self/fd/${id}`).catch(() => null)))
    return targets.filter(path => path === executable).length
  }
  const before = await descriptors(), began = performance.now()
  const native = createLinuxStartupObservation(process.pid, root, began)
  let release!: () => void, ready!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), captured = new Promise<void>(resolve => { ready = resolve })
  const observer = createBrowserStartupObserver(process.pid, began, {
    async snapshot(signal) {
      const result = await native.snapshot(signal).catch(() => ({ status: 'unavailable' as const, code: 'NATIVE_UNAVAILABLE' }))
      ready(); await held; return result
    },
    settleExecutables: hash => native.settleExecutables(hash), evidence: native.evidence,
  })
  let finishing: Promise<void> | undefined
  try {
    observer.tick(); await captured
    expect(await descriptors()).toBeGreaterThan(before)
    await Bun.sleep(600)
    finishing = observer.finishDiscovery()
    release(); await finishing
    const report = observer.evidence()
    expect(report.executables.length).toBeGreaterThan(0)
    expect(report.executables.every(e => e.sha256 === null && e.code === 'OBSERVATION_CANCELED' && e.closeCode === null)).toBe(true)
    expect(await descriptors()).toBe(before)
  }
  finally { release(); await (finishing ?? observer.finishDiscovery()); await rm(root, { recursive: true, force: true }) }
})
