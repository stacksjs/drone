import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { captureColdBuild } from '../../tests/helpers/runtime-cold-build-supervisor'
import { executableObservation, linuxResourceObservation, observationError } from './linux-browser-state'

// Restores actual app setup and the original inherited-group Chrome spawn.
// Reuses the qualified bounded process supervisor; no product qualification claim.
const count = 12
const output = process.argv[2], browser = process.env.BROWSE_BROWSER
if (process.platform !== 'linux' || !output || !isAbsolute(output) || !browser || !isAbsolute(browser)) throw new Error('Explicit Linux browser and new evidence directory required')
await mkdir(output, { mode: 0o700 })
const interruption = new AbortController()
process.once('SIGTERM', () => interruption.abort())
process.once('SIGINT', () => interruption.abort())
const source = resolve(import.meta.dir, '../..')
const initialBinary = await executableObservation('/opt/google/chrome/chrome')
const launcher = await executableObservation(browser)
const version = Bun.spawnSync([browser, '--version'], { timeout: 5000, maxBuffer: 65536, killSignal: 'SIGKILL' })
const results: Array<{ trial: number, passed: boolean, exitCode: number | null, failure: string | null, cleanupConfirmed: boolean, startup: unknown }> = []
const manifest = { kind: 'real-workspace-startup-research', productQualification: false, fullBrowserScenarioQualified: false, appBootstrapRestored: true, pageVisited: false, interrupted: false, sourceHead: process.env.PROBE_SOURCE_HEAD ?? null, originalProductHead: '35b9bd8a8b21f7ca59031f30b111b08a09207960', originalRun: 39856555655, trialCount: count, trialTimeoutMs: 100000, version: { exitCode: version.exitCode, stdout: version.stdout.toString(), stderr: version.stderr.toString() }, initialBinary, launcher, finalBinary: null as typeof initialBinary | null, bun: { version: Bun.version, revision: Bun.revision, binary: await executableObservation(process.execPath) }, image: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null }, startedAt: new Date().toISOString(), completedAt: null as string | null, failure: null as string | null, results }
const retain = () => writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
await retain()
try {
  for (let trial = 1; trial <= count && !interruption.signal.aborted; trial++) {
    const name = `trial-${String(trial).padStart(2, '0')}`
    const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
    const evidence = join(output, name)
    await mkdir(evidence, { mode: 0o700 })
    const config = join(root, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    await writeFile(join(evidence, 'started.json'), `${JSON.stringify({ trial, at: new Date().toISOString(), before: await linuxResourceObservation() }, null, 2)}\n`, { mode: 0o600 })
    let capture: Awaited<ReturnType<typeof captureColdBuild>> | undefined, failure: string | null = null
    try {
      capture = await captureColdBuild([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', join(source, 'tests/fixtures/public-safety-access/workspace-browser.ts')], { cwd: root, timeoutMs: 100000, signal: interruption.signal, env: { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite'), STX_DIR: join(root, 'stx'), WORKSPACE_BROWSER_EVIDENCE: evidence, WORKSPACE_BROWSER_CONTROL_ONLY: undefined, WORKSPACE_BROWSER_STARTUP_ONLY: 'true', BROWSER_STARTUP_PROCESS_OBSERVATIONS: 'true' } })
      // Raw app output and credentials stay outside the artifact allowlist.
      await writeFile(join(root, 'subject.stdout'), capture.stdout, { mode: 0o600 })
      await writeFile(join(root, 'subject.stderr'), capture.stderr, { mode: 0o600 })
      if (capture.failure) failure = observationError(capture.failure)
    }
    catch (error) { failure = observationError(error) }
    const startup = await readFile(join(evidence, 'browser-startup-process.json'), 'utf8').then(value => JSON.parse(value) as { phase: string }).catch(() => null)
    const cleanupConfirmed = capture !== undefined && !capture.rootGroupRemaining && capture.probeErrors.length === 0
    const passed = !interruption.signal.aborted && !failure && cleanupConfirmed && capture?.exitCode === 0 && capture.stdout.includes('PASS actual workspace startup-only control') && startup?.phase === 'discovered'
    const result = { trial, passed, exitCode: capture?.exitCode ?? null, failure, cleanupConfirmed, startup }
    results.push(result)
    await writeFile(join(evidence, 'result.json'), `${JSON.stringify({ ...result, after: await linuxResourceObservation(), deadlineReached: capture?.deadlineReached ?? null, profileRetained: !passed }, null, 2)}\n`, { mode: 0o600 })
    await retain()
    console.log(JSON.stringify({ trial, passed, exitCode: result.exitCode, failure, cleanupConfirmed, startupPhase: startup?.phase ?? null }))
    if (passed) await rm(root, { recursive: true })
    if (!cleanupConfirmed) break
  }
}
catch (error) { manifest.failure = observationError(error) }
finally {
  manifest.interrupted = interruption.signal.aborted
  manifest.finalBinary = await executableObservation('/opt/google/chrome/chrome').catch(() => null)
  manifest.completedAt = new Date().toISOString()
  await retain()
}
process.exitCode = !manifest.interrupted && !manifest.failure && version.exitCode === 0 && version.stdout.toString().trim().length > 0 && manifest.finalBinary?.sha256 === initialBinary.sha256 && results.length === count && results.every(value => value.passed) ? 0 : 1
