import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
    expect(report.startup.platform).toBe(process.platform)
    expect(report.startup.method).toBe('startup-only-process-observation-v1')
    expect(report.startup.snapshots.at(-1).label).toBe('cleanup-ended')
    expect(report.startup.snapshots.at(-1).root.pid).toBe(actualPid)
    expect(report.startup.snapshots.at(-1).root.probe).toBe('missing')
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

// The existing native launch seam checks observed processes, not the cause of a Chrome failure.
test.skipIf(process.platform === 'win32')('a live native launcher and child remain observable until cleanup without exporting argv or environment', async () => {
  const supplied = process.env.BROWSER_LAUNCH_LIVE_EVIDENCE
  const root = supplied ? (await mkdir(supplied), supplied) : await mkdtemp(join(tmpdir(), 'drone-browser-live-'))
  const executable = join(root, 'launch.ts'), pidPath = join(root, 'pids.json')
  const original = process.env.BROWSE_BROWSER
  let passed = false
  try {
    await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'\nconst child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)','PRIVATE_CHILD_ARG_SENTINEL'],{stdout:'ignore',stderr:'ignore',env:{...process.env,PRIVATE_FIXTURE_TOKEN:'PRIVATE_CHILD_ENV_SENTINEL'}})\nwriteFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]))\nprocess.on('SIGTERM',async()=>{child.kill();await child.exited;process.exit(0)})\nconsole.error('controlled live browser startup fixture')\nsetInterval(()=>{},1000)\n`, { mode: 0o700 })
    process.env.BROWSE_BROWSER = executable
    await expect(startWorkspaceBrowser(root)).rejects.toThrow('Fresh browser must start')
    const [pid, childPid] = JSON.parse(await readFile(pidPath, 'utf8')) as [number, number]
    const text = await readFile(join(root, 'browser-launch.json'), 'utf8'), report = JSON.parse(text)
    expect(text).not.toContain('PRIVATE_CHILD_ARG_SENTINEL')
    expect(text).not.toContain('PRIVATE_CHILD_ENV_SENTINEL')
    expect(report.portProbe.attempts).toBe(400)
    expect(report.launch.exitObservedBeforeCleanup).toBe(false)
    expect(report.launch.exitObserved).toBe(true)
    const before = report.startup.snapshots.find((s: any) => s.label === 'discovery-ended')
    expect(before.root.pid).toBe(pid)
    expect(before.root.probe).toBe('present')
    expect(report.startup.snapshots.at(-1).root.probe).toBe('missing')
    expect(report.startup.executables).toBeArray()
    if (process.platform === 'linux') {
      expect(before.linux.status).toBe('observed')
      expect(before.linux.root.startTicks).toMatch(/^\d+$/)
      expect(before.linux.root.rssKiB).toBeGreaterThan(0)
      expect(before.linux.descendants.some((p: any) => p.pid === childPid && p.parentPid === pid)).toBe(true)
      const identity = report.startup.executables.find((e: any) => e.observedPids.includes(pid) && e.sha256 !== null)
      expect(identity).toBeDefined()
      expect(identity.byteLength).toBe((await stat(process.execPath)).size)
      expect(identity.sha256).toBe(new Bun.CryptoHasher('sha256').update(await Bun.file(process.execPath).arrayBuffer()).digest('hex'))
      expect(identity.hashedAfterDiscovery).toBe(true)
    }
    else expect(before.linux.status).toBe('unsupported')
    expect(() => process.kill(pid, 0)).toThrow()
    expect(() => process.kill(childPid, 0)).toThrow()
    passed = true
  }
  finally {
    if (original === undefined) delete process.env.BROWSE_BROWSER
    else process.env.BROWSE_BROWSER = original
    const pids: number[] = JSON.parse(await readFile(pidPath, 'utf8').catch(() => '[]'))
    for (const pid of pids) {
      let gone = false
      try { process.kill(pid, 0) }
      catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
      expect(gone).toBe(true)
    }
    if (passed && !supplied) await rm(root, { recursive: true, force: true })
    else console.log(JSON.stringify({ evidence: 'controlled-live-native-launch', retainedRoot: root, passed }))
  }
}, 35000)
