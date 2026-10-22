import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { captureColdBuild, coldBuildQualificationTimeout } from '../tests/helpers/runtime-cold-build-supervisor'

// Exercise actual build/test initialization across the former 20-second hook.
// Tool witnesses forward to real CMake/CTest and retain actual child settlement.
interface ToolEvent { event: 'start' | 'spawn' | 'exit', stage: string, groupId: number, pid: number, exitCode?: number, elapsedMs?: number }
assert(process.platform !== 'win32', 'Cold build qualification requires POSIX process groups')
assert(process.argv[2], 'Provide a new owned evidence directory')
const reportingFault = process.argv[3] === '--interrupt-before-capture-report'
assert(process.argv.length <= 4 && (!process.argv[3] || reportingFault), 'Unknown qualification mode')
const repository = resolve(import.meta.dir, '..'), evidence = resolve(process.argv[2]!)
await mkdir(evidence)
if (reportingFault) await mkdir(join(evidence, 'capture-result.json'))
const project = join(evidence, 'project'), tools = join(evidence, 'tools'), eventsPath = join(evidence, 'tool-events.ndjson')
await mkdir(join(project, 'firmware'), { recursive: true })
await mkdir(tools)
await cp(join(repository, 'firmware/runtime'), join(project, 'firmware/runtime'), { recursive: true })
await writeFile(join(project, 'bunfig.toml'), '[test]\npreload = []\n')
const cmakePath = join(project, 'firmware/runtime/CMakeLists.txt'), cmake = await readFile(cmakePath, 'utf8')
assert(cmake.startsWith('cmake_minimum_required(VERSION 3.20)'), 'Expected recorded runtime CMake entrypoint')
await writeFile(cmakePath, cmake.replace('cmake_minimum_required(VERSION 3.20)', 'cmake_minimum_required(VERSION 3.20)\nexecute_process(COMMAND "${CMAKE_COMMAND}" -E sleep 21 COMMAND_ERROR_IS_FATAL ANY)'))
assert(!await Bun.file(join(project, 'storage/runtime-build/host/CMakeCache.txt')).exists(), 'Qualification must start cold')
assert(!/\s/.test(process.execPath), 'Tool witness needs a single executable shebang path')
for (const tool of ['cmake', 'ctest']) {
  const executable = Bun.which(tool)
  assert(executable, `Missing native tool: ${tool}`)
  const source = String.raw`#!${process.execPath}
import { appendFileSync } from 'node:fs'
const stage = ${JSON.stringify(tool)} === 'ctest' ? 'contracts' : process.argv[2] === '-S' ? 'configure' : 'compile'
const began = performance.now()
const owner = { stage, groupId: process.pid, pid: process.pid }
appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ ...owner, event: 'start' }) + '\n')
const child = Bun.spawn([${JSON.stringify(executable)}, ...process.argv.slice(2)], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
const event = { stage, groupId: process.pid, pid: child.pid }
appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ ...event, event: 'spawn' }) + '\n')
if (${reportingFault} && stage === 'configure') {
  process.kill(child.pid, 0)
  process.kill(process.ppid, 'SIGKILL')
}
const exitCode = await child.exited
appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ ...event, event: 'exit', exitCode, elapsedMs: performance.now() - began }) + '\n')
process.exit(exitCode)
`
  await writeFile(join(tools, tool), source, { mode: 0o700 })
}
const pattern = process.platform === 'linux' ? 'kernel-confirmed full input FIFO' : 'separate supervised boots'
const buildCommandTimeoutMs = 120000, selectedTestTimeoutMs = process.platform === 'linux' ? 20000 : 5000
const qualificationTimeoutMs = coldBuildQualificationTimeout(buildCommandTimeoutMs, selectedTestTimeoutMs)
let result: Awaited<ReturnType<typeof captureColdBuild>> | undefined, failure: unknown
const began = performance.now()
try {
  result = await captureColdBuild([process.execPath, 'test', join(repository, 'tests/unit/runtime.test.ts'), '--test-name-pattern', pattern], { cwd: project, env: { ...process.env, PATH: `${tools}:${process.env.PATH ?? ''}` }, timeoutMs: qualificationTimeoutMs })
  failure = result.failure
}
catch (error) { failure = error }
// Retain the capture outcome even if a later cleanup observation itself fails.
const reportingErrors: { stage: string, code: string | null }[] = []
try {
  await writeFile(join(evidence, 'capture-result.json'), `${JSON.stringify({ exitCode: result?.exitCode ?? null, elapsedMs: performance.now() - began, failure: failure instanceof Error ? failure.message : failure ? String(failure) : null }, null, 2)}\n`)
}
catch (error) {
  failure ??= error
  reportingErrors.push({ stage: 'capture-result', code: (error as NodeJS.ErrnoException).code ?? null })
}
let eventText = ''
try { eventText = await readFile(eventsPath, 'utf8') }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
const events: ToolEvent[] = []
for (const line of eventText.split('\n').filter(Boolean)) {
  try { events.push(JSON.parse(line)) }
  catch (error) { failure ??= error }
}
const groups = [...new Set(events.map(event => event.groupId))]
assert(groups.every(group => Number.isSafeInteger(group) && group > 1), 'Tool witnesses must identify owned process groups')
const probeErrors: { group: number, code: string }[] = []
const cleanupErrors: { group: number, code: string | null }[] = []
function alive(group: number): boolean {
  try { process.kill(-group, 0); return true }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') {
      if (probeErrors.length < 20) probeErrors.push({ group, code })
      return true // Unknown membership remains live until an actual absence probe.
    }
    failure ??= error
    if (cleanupErrors.length < 20) cleanupErrors.push({ group, code: code ?? null })
    return true
  }
}
const beforeCleanup = groups.filter(alive)
for (const group of beforeCleanup) {
  try { process.kill(-group, 'SIGKILL') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      failure ??= error
      cleanupErrors.push({ group, code: (error as NodeJS.ErrnoException).code ?? null })
    }
  }
}
const cleanupDeadline = performance.now() + 5000
while (groups.some(alive) && performance.now() < cleanupDeadline) await Bun.sleep(25)
const afterCleanup = groups.filter(alive)
await writeFile(join(evidence, 'stdout.log'), result?.stdout ?? '')
await writeFile(join(evidence, 'stderr.log'), result?.stderr ?? '')
const report = { evidence: reportingFault ? 'controlled-cold-native-report-refusal' : 'controlled-cold-native-build', platform: process.platform, bun: Bun.version, pattern, reportingFault, configureDelaySeconds: 21, buildCommandTimeoutMs, selectedTestTimeoutMs, qualificationTimeoutMs, subjectExitCode: result?.exitCode ?? null, captureAvailable: result !== undefined, capture: result ? { pid: result.pid, deadlineReached: result.deadlineReached, stopRequested: result.stopRequested, rootCleanupRequired: result.rootCleanupRequired, rootGroupRemaining: result.rootGroupRemaining, probeErrors: result.probeErrors } : null, elapsedMs: performance.now() - began, events, beforeCleanup, afterCleanup, probeErrors, cleanupErrors, reportingErrors, failure: failure instanceof Error ? failure.message : failure ? String(failure) : null, physicalFlightEnabled: false }
await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`)
assert.equal(afterCleanup.length, 0, 'Owned tool groups must settle before any evidence removal')
assert.equal(cleanupErrors.length, 0, 'Unexpected tool cleanup errors must remain qualification failures')
assert(result, 'Actual parent capture must be available')
assert.equal(result.rootGroupRemaining, false, 'The actual parent process group must settle')
if (reportingFault) {
  assert.notEqual(result.exitCode, 0, 'The actual test parent must have been interrupted')
  assert(failure instanceof Error && (failure as NodeJS.ErrnoException).code === 'EISDIR', 'Retain the actual report refusal')
  assert(reportingErrors.some(error => error.stage === 'capture-result' && error.code === 'EISDIR'))
  assert(beforeCleanup.length > 0, 'Reporting refusal must encounter a real live detached tool group')
}
else {
  if (failure) throw failure
  assert.equal(result.exitCode, 0, 'Original selected native runtime test must pass')
  assert.equal(result.rootCleanupRequired, false, 'A successful qualification must require no parent group cleanup')
  assert.match(result.stderr, /1 pass/)
  assert.match(result.stderr, /0 fail/)
  assert.equal(beforeCleanup.length, 0, 'A successful build must require no controller cleanup')
  const exits = events.filter(event => event.event === 'exit')
  assert.deepEqual(exits.map(event => event.stage), ['configure', 'compile', 'contracts'])
  assert(exits.every(event => event.exitCode === 0), 'Real CMake and CTest must exit cleanly')
  assert(exits[0]!.elapsedMs! >= 21000, 'Actual configure must cross the former setup hook')
  assert(await Bun.file(join(project, 'storage/runtime-build/host/drone_runtime_host')).exists(), 'Real compiler output must exist')
}
console.log(JSON.stringify(report))
