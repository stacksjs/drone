import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { startWorkspaceBrowser } from '../helpers/workspace-browser'

test.skipIf(process.platform === 'win32')('failed native launch retains startup stderr, actual exit and port observations at the original discovery bound', async () => {
  const supplied = process.env.BROWSER_LAUNCH_EVIDENCE
  const root = supplied ? (await mkdir(supplied), supplied) : await mkdtemp(join(tmpdir(), 'drone-browser-launch-'))
  const executable = join(root, 'launch.ts'), pidPath = join(root, 'launch.pid')
  let passed = false
  const original = process.env.BROWSE_BROWSER
  try {
    await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid))\nconsole.error('controlled native browser startup refusal')\nprocess.exit(23)\n`, { mode: 0o700 })
    process.env.BROWSE_BROWSER = executable
    await expect(startWorkspaceBrowser(root)).rejects.toThrow('Fresh browser must start')
    const actualPid = Number(await readFile(pidPath, 'utf8'))
    const report = JSON.parse(await readFile(join(root, 'browser-launch.json'), 'utf8'))
    expect(report.phase).toBe('startup-unavailable')
    expect(report.launch.pid).toBe(actualPid)
    expect(report.launch.exitObserved).toBe(true)
    expect(report.launch.settledExitCode).toBe(23)
    expect(report.launch.exitObservedBeforeCleanup).toBe(true)
    expect(report.launch.cleanupRequested).toBe(true)
    expect(report.portProbe.attempts).toBe(400)
    expect(report.portProbe.lastReadError).toBe('ENOENT')
    expect(report.stderr.status).toBe('retained')
    expect(report.stderr.retainedBytes).toBeLessThanOrEqual(65536)
    expect(await readFile(join(root, 'chrome-startup-stderr.log'), 'utf8')).toContain('controlled native browser startup refusal')
    expect(() => process.kill(actualPid, 0)).toThrow()
    passed = true
  }
  finally {
    if (original === undefined) delete process.env.BROWSE_BROWSER
    else process.env.BROWSE_BROWSER = original
    // The owned native program exits23 before discovery completes; never delete a live fixture.
    const actualPid = Number(await readFile(pidPath, 'utf8').catch(() => '0'))
    if (actualPid > 1) {
      let gone = false
      try { process.kill(actualPid, 0) }
      catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
      expect(gone).toBe(true)
    }
    if (passed && !supplied) await rm(root, { recursive: true, force: true })
    else console.log(JSON.stringify({ evidence: 'controlled-native-launch', retainedRoot: root, passed }))
  }
}, 30000)
