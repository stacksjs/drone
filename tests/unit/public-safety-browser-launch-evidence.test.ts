import { expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retainBrowserLaunchEvidence } from '../helpers/browser-launch-evidence'
import type { BrowserLaunchObservation } from '../helpers/browser-launch-evidence'

const observation: BrowserLaunchObservation = { phase: 'startup-unavailable', elapsedMs: 20000, launch: { pid: 12345, exitObserved: true, settledExitCode: 23, signalCode: null, exitObservedBeforeCleanup: true, cleanupRequested: true, exitElapsedMs: 10 }, portProbe: { attempts: 400, successfulReads: 0, failedReads: 400, lastReadError: 'ENOENT', discovered: false } }

test('startup capture retains only a bounded native stderr tail at both evidence destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-browser-evidence-')), exported = join(root, 'export')
  try {
    const source = 'unretained-prefix'.repeat(5000) + 'x'.repeat(65500) + 'controlled-tail'
    await writeFile(join(root, 'chrome.log'), source)
    expect(await retainBrowserLaunchEvidence(root, observation, { startupStderr: true, exportDirectory: exported })).toEqual({ local: true, export: true })
    for (const directory of [root, exported]) {
      const report = JSON.parse(await readFile(join(directory, 'browser-launch.json'), 'utf8'))
      expect(report.stderr.totalBytes).toBe(Buffer.byteLength(source))
      expect(report.stderr.retainedBytes).toBe(65536)
      expect(report.stderr.truncated).toBe(true)
      const captured = await readFile(join(directory, 'chrome-startup-stderr.log'))
      expect(captured.byteLength).toBe(65536)
      expect(captured.equals(Buffer.from(source).subarray(-65536))).toBe(true)
      expect((await stat(join(directory, 'browser-launch.json'))).mode & 0o777).toBe(0o600)
    }
    expect(await readFile(join(root, 'chrome.log'), 'utf8')).toBe(source)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('post-navigation capture withholds private stderr and exports only lifecycle scalars', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-browser-evidence-')), exported = join(root, 'export')
  try {
    await writeFile(join(root, 'chrome.log'), 'PRIVATE_FIXTURE_CREDENTIAL_SENTINEL')
    const result = await retainBrowserLaunchEvidence(root, { ...observation, phase: 'closed' }, { startupStderr: false, exportDirectory: exported })
    expect(result).toEqual({ local: true, export: true })
    expect(await readdir(exported)).toEqual(['browser-launch.json'])
    const publicText = await readFile(join(exported, 'browser-launch.json'), 'utf8')
    expect(publicText).not.toContain('PRIVATE_FIXTURE_CREDENTIAL_SENTINEL')
    expect(JSON.parse(publicText).stderr.status).toBe('withheld')
    expect(await readFile(join(root, 'chrome.log'), 'utf8')).toBe('PRIVATE_FIXTURE_CREDENTIAL_SENTINEL')
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('actual refused metadata and export paths report unavailable without replacing the browser failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-browser-evidence-')), exported = join(root, 'not-a-directory')
  try {
    await writeFile(join(root, 'chrome.log'), 'controlled startup message')
    await mkdir(join(root, 'browser-launch.json'))
    await writeFile(exported, 'owned obstruction')
    const original = new Error('original browser failure')
    const run = async () => { await retainBrowserLaunchEvidence(root, observation, { startupStderr: true, exportDirectory: exported }); throw original }
    await expect(run()).rejects.toBe(original)
    expect(await readFile(exported, 'utf8')).toBe('owned obstruction')
  }
  finally { await rm(root, { recursive: true, force: true }) }
})
