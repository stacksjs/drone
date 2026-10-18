export interface ParityProcessOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs: number
  stdoutBytes: number
  stderrBytes: number
  label: string
}

/** Owns a finite command, its output readers and, on POSIX, its process group. */
export async function runParityProcess(command: string[], options: ParityProcessOptions) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000) throw new Error('Invalid parity process timeout')
  for (const limit of [options.stdoutBytes, options.stderrBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000_000) throw new Error('Invalid parity process output limit')
  }
  const ownsGroup = process.platform !== 'win32'
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env ?? process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: ownsGroup })
  const readers = [child.stdout.getReader(), child.stderr.getReader()]
  const cancellations: Promise<unknown>[] = []
  let failure: Error | undefined, stopped = false
  function terminate() {
    if (ownsGroup) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* The group may already be gone. */ } }
    try { child.kill('SIGKILL') } catch { /* The direct child may already have exited. */ }
  }
  function stop(error: Error) {
    failure ??= error
    if (stopped) return
    stopped = true
    terminate()
    for (const reader of readers) cancellations.push(reader.cancel().catch(() => {}))
  }
  async function consume(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number, label: string) {
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return Buffer.concat(chunks, bytes).toString('utf8')
        if (value.byteLength > limit - bytes) throw new Error(`${options.label} ${label} exceeds byte limit`)
        bytes += value.byteLength
        chunks.push(value)
      }
    }
    catch (error) { stop(error instanceof Error ? error : new Error(String(error))); throw error }
  }
  const timer = setTimeout(() => stop(new Error(`${options.label} timed out`)), options.timeoutMs)
  const stdout = consume(readers[0]!, options.stdoutBytes, 'stdout'), stderr = consume(readers[1]!, options.stderrBytes, 'stderr')
  try {
    const [exitCode, output, diagnostic] = await Promise.all([child.exited, stdout, stderr])
    if (failure) throw failure
    return { exitCode, stdout: output, stderr: diagnostic }
  }
  finally {
    clearTimeout(timer)
    terminate()
    if (child.exitCode === null) stop(new Error(`${options.label} interrupted`))
    await Promise.allSettled([child.exited, stdout, stderr, ...cancellations])
    for (const reader of readers) reader.releaseLock()
  }
}
