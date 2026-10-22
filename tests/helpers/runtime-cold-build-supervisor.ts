import { Buffer } from 'node:buffer'
import process from 'node:process'

/** Test-only ownership of the aggregate build/test process, beyond a single command's budget. */
export interface ColdBuildCapture {
  exitCode: number
  stdout: string
  stderr: string
  pid: number
  timeoutMs: number
  deadlineReached: boolean
  stopRequested: boolean
  rootCleanupRequired: boolean
  rootGroupRemaining: boolean
  probeErrors: string[]
  failure: unknown
}

export const coldBuildCaptureBytes = 2_000_000
export const coldBuildSettlementMs = 5000

/** Three build commands, each with its own settlement allowance, then the unchanged selected test. */
export function coldBuildQualificationTimeout(commandTimeoutMs: number, selectedTestTimeoutMs: number): number {
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 120000)
    throw new Error('Invalid cold-build command budget')
  if (![5000, 20000].includes(selectedTestTimeoutMs))
    throw new Error('Invalid selected runtime test budget')
  return 3 * (commandTimeoutMs + coldBuildSettlementMs) + selectedTestTimeoutMs + 10000
}

export async function captureColdBuild(command: string[], options: { cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number }): Promise<ColdBuildCapture> {
  if (process.platform === 'win32') throw new Error('Cold build capture requires POSIX process groups')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 405000)
    throw new Error('Invalid aggregate cold-build budget')
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
  const readers = [child.stdout.getReader(), child.stderr.getReader()]
  const chunks: Uint8Array[][] = [[], []], sizes = [0, 0]
  const cancellations: Promise<unknown>[] = [], cleanupErrors: unknown[] = [], probeErrors: string[] = []
  let exited = false, groupTerminated = false
  let failure: unknown, deadlineReached = false, stopped = false, rootCleanupRequired = false, pipeTimer: ReturnType<typeof setTimeout> | undefined
  const group = (signal: NodeJS.Signals | 0): boolean => {
    try { process.kill(-child.pid, signal); return true }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      if (signal === 0 && code === 'EPERM') {
        if (probeErrors.length < 20) probeErrors.push(code)
        return true // Permission uncertainty never proves that ownership has settled.
      }
      throw error
    }
  }
  const groupExists = (): boolean => {
    try { return group(0) }
    catch (error) { cleanupErrors.push(error); return true }
  }
  const terminate = () => {
    if (!groupTerminated) {
      try { group('SIGKILL'); groupTerminated = true }
      catch (error) { cleanupErrors.push(error) }
    }
    if (!exited && !groupTerminated) {
      try { child.kill('SIGKILL') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupErrors.push(error) }
    }
  }
  const stop = (error: unknown) => {
    failure ??= error
    if (stopped) return
    stopped = true
    terminate()
    for (const reader of readers) cancellations.push(reader.cancel().catch(error => { cleanupErrors.push(error) }))
  }
  async function consume(index: number): Promise<void> {
    try {
      while (true) {
        const { done, value } = await readers[index]!.read()
        if (done) return
        const room = coldBuildCaptureBytes - sizes[index]!
        const retained = value.subarray(0, room)
        if (retained.byteLength) { chunks[index]!.push(retained); sizes[index]! += retained.byteLength }
        if (value.byteLength > room) { stop(new Error(`Cold build ${index === 0 ? 'stdout' : 'stderr'} exceeds byte limit`)); return }
      }
    }
    catch (error) { stop(error) }
  }
  const timer = setTimeout(() => { deadlineReached = true; stop(new Error('Aggregate cold build qualification timed out')) }, options.timeoutMs)
  const outputs = [consume(0), consume(1)]
  let exitCode: number
  try {
    exitCode = await child.exited
    exited = true
    clearTimeout(timer)
    pipeTimer = setTimeout(() => stop(new Error('Cold build inherited output pipes did not settle')), coldBuildSettlementMs)
    await Promise.all(outputs)
  }
  finally {
    clearTimeout(timer)
    clearTimeout(pipeTimer)
    rootCleanupRequired = groupExists()
    terminate()
    await Promise.allSettled([child.exited, ...outputs, ...cancellations])
    for (const reader of readers) {
      try { reader.releaseLock() }
      catch (error) { cleanupErrors.push(error) }
    }
  }
  const end = performance.now() + coldBuildSettlementMs
  while (groupExists() && performance.now() < end) await Bun.sleep(25)
  const rootGroupRemaining = groupExists()
  if (rootGroupRemaining) cleanupErrors.push(new Error('Owned cold-build parent group did not settle'))
  if (cleanupErrors.length) failure = new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'Cold-build capture cleanup failed')
  return { exitCode, stdout: Buffer.concat(chunks[0]!, sizes[0]).toString('utf8'), stderr: Buffer.concat(chunks[1]!, sizes[1]).toString('utf8'), pid: child.pid, timeoutMs: options.timeoutMs, deadlineReached, stopRequested: stopped, rootCleanupRequired, rootGroupRemaining, probeErrors, failure }
}
