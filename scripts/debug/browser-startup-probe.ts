import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import process from 'node:process'

// Native Linux capability research only. No application imports or page visits.
const trialCount = 24
const attemptsLimit = 400
const pollMs = 50
const stderrLimit = 65536
const flags = ['--headless=new', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', '--disable-dev-shm-usage', '--disable-extensions', '--disable-component-update', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0']
const [output, profiles] = process.argv.slice(2)
const browser = process.env.BROWSE_BROWSER
if (process.platform !== 'linux' || !browser || !output || !profiles || ![browser, output, profiles].every(isAbsolute) || !relative(output, profiles).startsWith('..') || !relative(profiles, output).startsWith('..'))
  throw new Error('Explicit Linux browser and separate new evidence/profile directories required')
await mkdir(output, { recursive: false, mode: 0o700 })
await mkdir(profiles, { recursive: false, mode: 0o700 })
let interrupted = false
process.once('SIGTERM', () => { interrupted = true })
process.once('SIGINT', () => { interrupted = true })

function code(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable'
}

async function textFile(path: string) {
  try { return { value: (await readFile(path, 'utf8')).slice(0, 32768), error: null } }
  catch (error) { return { value: null, error: code(error) } }
}

async function identity(path: string) {
  const resolved = await realpath(path)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(resolved)) { hash.update(chunk); bytes += chunk.length }
  return { path, resolved, bytes, sha256: hash.digest('hex') }
}

function groupExists(pid: number) {
  try { process.kill(-pid, 0); return true }
  catch (error) { if (code(error) === 'ESRCH') return false; throw error }
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal) }
  catch (error) { if (code(error) !== 'ESRCH') throw error }
}

async function joinGroup(child: ReturnType<typeof Bun.spawn>) {
  let rootJoined = false
  const joined = child.exited.then(() => { rootJoined = true })
  signalGroup(child.pid, 'SIGTERM')
  let killed = false
  const began = performance.now()
  while ((!rootJoined || groupExists(child.pid)) && performance.now() - began < 4000) {
    if (!killed && performance.now() - began >= 2000) { signalGroup(child.pid, 'SIGKILL'); killed = true }
    await Bun.sleep(25)
  }
  if (rootJoined) await joined
  return { rootJoined, groupGone: !groupExists(child.pid), sigkillRequested: killed, exitCode: child.exitCode, signal: child.signalCode }
}

async function processState(pid: number) {
  const entry = await textFile(`/proc/${pid}/stat`)
  const fields = entry.value?.slice(entry.value.lastIndexOf(') ') + 2).trim().split(/\s+/)
  const status = await textFile(`/proc/${pid}/status`)
  const selectedStatus = status.value?.split('\n').filter(line => /^(?:Name|State|Pid|PPid|Threads|VmRSS|VmSize):/.test(line)) ?? null
  return { pid, error: entry.error, state: fields?.[0] ?? null, parent: Number(fields?.[1]) || null, group: Number(fields?.[2]) || null, session: Number(fields?.[3]) || null, startTicks: fields?.[19] ?? null, status: selectedStatus, wait: await textFile(`/proc/${pid}/wchan`) }
}

async function groupState(pid: number) {
  const allIds = (await readdir('/proc')).filter(name => /^\d+$/.test(name))
  const ids = allIds.slice(0, 2048)
  const members = []
  for (const id of ids) {
    const raw = await textFile(`/proc/${id}/stat`)
    const fields = raw.value?.slice(raw.value.lastIndexOf(') ') + 2).trim().split(/\s+/)
    if (Number(fields?.[2]) === pid) members.push(Number(id))
  }
  const tasks = await readdir(`/proc/${pid}/task`).catch(() => [])
  const threads = await Promise.all(tasks.slice(0, 64).map(async id => ({ id, name: await textFile(`/proc/${pid}/task/${id}/comm`), wait: await textFile(`/proc/${pid}/task/${id}/wchan`) })))
  return { root: await processState(pid), observedProcessCount: ids.length, processScanCapped: allIds.length > ids.length, memberCount: members.length, members: await Promise.all(members.slice(0, 48).map(processState)), memberDetailsCapped: members.length > 48, threadCount: tasks.length, threads, threadDetailsCapped: tasks.length > 64 }
}

async function resources() {
  const membership = await textFile('/proc/self/cgroup')
  const path = membership.value?.split('\n').find(line => line.startsWith('0::'))?.slice(3)
  const cgroup = path && path.startsWith('/') && !path.split('/').includes('..') ? join('/sys/fs/cgroup', path) : null
  const counters: Record<string, Awaited<ReturnType<typeof textFile>>> = {}
  if (cgroup) {
    for (const name of ['memory.current', 'memory.max', 'memory.events', 'cpu.stat', 'pids.current', 'pids.max']) counters[name] = await textFile(join(cgroup, name))
  }
  return { scope: 'probe process cgroup, potentially shared with runner processes', membership, counters, memoryPressure: await textFile('/proc/pressure/memory'), cpuPressure: await textFile('/proc/pressure/cpu') }
}

async function startupStderr(path: string, name: string) {
  const file = await open(path, 'r')
  try {
    const total = (await file.stat()).size
    const buffer = Buffer.alloc(Math.min(total, stderrLimit))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, total - buffer.length))
    const retained = buffer.subarray(0, bytesRead)
    await writeFile(join(output!, `${name}.startup-stderr.log`), retained, { flag: 'wx', mode: 0o600 })
    return { totalBytes: total, retainedBytes: bytesRead, truncated: total > bytesRead, sha256: createHash('sha256').update(retained).digest('hex') }
  }
  finally { await file.close() }
}

async function trial(index: number) {
  const name = `trial-${String(index).padStart(2, '0')}`
  const profile = join(profiles!, name)
  await mkdir(profile, { mode: 0o700 })
  const before = await resources()
  await writeFile(join(output!, `${name}.started.json`), `${JSON.stringify({ index, name, startedAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 })
  const began = performance.now()
  const child = Bun.spawn([browser!, ...flags, `--user-data-dir=${profile}`, 'about:blank'], { detached: true, stdout: 'ignore', stderr: Bun.file(join(profile, 'chrome.log')) })
  let cleanupRequested = false
  const exit = { observed: false, beforeCleanup: false, elapsedMs: null as number | null, code: null as number | null }
  void child.exited.then(value => { exit.observed = true; exit.beforeCleanup = !cleanupRequested; exit.elapsedMs = performance.now() - began; exit.code = value })
  const portProbe = { attempts: 0, successfulReads: 0, failedReads: 0, lastReadError: null as string | null, discovered: false }
  let failure: string | null = null
  let observation: Awaited<ReturnType<typeof groupState>> | null = null
  let discoveryElapsedMs = 0
  try {
    for (let attempt = 0; attempt < attemptsLimit && !interrupted; attempt++) {
      portProbe.attempts++
      let port = ''
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] ?? ''; portProbe.successfulReads++; portProbe.lastReadError = null }
      catch (error) { portProbe.failedReads++; portProbe.lastReadError = code(error) }
      if (port) { portProbe.discovered = true; break }
      await Bun.sleep(pollMs)
    }
    discoveryElapsedMs = performance.now() - began
    observation = await groupState(child.pid)
  }
  catch (error) { failure = code(error) }
  finally { cleanupRequested = true }
  const cleanup = await joinGroup(child)
  const after = await resources()
  const stderr = await startupStderr(join(profile, 'chrome.log'), name)
  const passed = portProbe.discovered && !failure && !interrupted && cleanup.rootJoined && cleanup.groupGone
  const result = { index, name, passed, interrupted, failure, portProbe, discoveryElapsedMs, observation, exit, cleanup, before, after, stderr, profileRetained: !passed, profileLabel: name }
  await writeFile(join(output!, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  if (passed) await rm(profile, { recursive: true })
  return result
}

const binary = await identity(browser)
const backing = await stat('/opt/google/chrome/chrome').then(() => identity('/opt/google/chrome/chrome')).catch(() => null)
const version = Bun.spawnSync([browser, '--version'], { timeout: 5000, maxBuffer: 65536, killSignal: 'SIGKILL' })
const trials: Awaited<ReturnType<typeof trial>>[] = []
const manifest = {
  kind: 'native-linux-chrome-startup-capability-campaign', productQualification: false, droneImported: false, pageVisited: false,
  sourceHead: process.env.PROBE_SOURCE_HEAD ?? null, bunVersion: Bun.version, bunRevision: Bun.revision,
  binary, backing, runtimeBinary: await identity(process.execPath), probeSource: await identity(import.meta.path), versionAvailable: version.exitCode === 0 && version.stdout.toString().trim().length > 0, version: { exitCode: version.exitCode, stdout: version.stdout.toString(), stderr: version.stderr.toString() },
  image: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null },
  original: { head: '35b9bd8a8b21f7ca59031f30b111b08a09207960', run: 39856555655, job: 120096152856, originalChromeVersionUnknown: true },
  limits: ['No application or browser page qualification', 'Detached helpers that leave the owned process group are not proven gone', 'A successful discovery file read does not verify CDP or application readiness'],
  changesFromOriginal: ['Application bootstrap and page activity removed', 'Each Chrome owns a detached process group for bounded cleanup', 'Process and resource observations outside the discovery loop'],
  guard: { attemptsLimit, pollMs }, command: [browser, ...flags, '--user-data-dir=<fresh-profile>', 'about:blank'], trialCount,
  startedAt: new Date().toISOString(), completedAt: null as string | null, error: null as string | null, trials,
}
const retain = () => writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
await retain()
try {
  for (let index = 1; index <= trialCount && !interrupted; index++) {
    const result = await trial(index)
    trials.push(result)
    await retain()
    console.log(JSON.stringify({ trial: index, passed: result.passed, attempts: result.portProbe.attempts, elapsedMs: result.discoveryElapsedMs, cleanup: result.cleanup }))
    if (!result.cleanup.rootJoined || !result.cleanup.groupGone) break
  }
}
catch (error) { manifest.error = code(error) }
finally { manifest.completedAt = new Date().toISOString(); await retain() }
process.exitCode = !interrupted && !manifest.error && manifest.versionAvailable && trials.length === trialCount && trials.every(value => value.passed) ? 0 : 1
