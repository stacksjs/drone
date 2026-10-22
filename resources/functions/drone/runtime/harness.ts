import { decodeRuntimeFrame } from './protocol'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshBootId() {
  let value = 0n
  while (value === 0n) value = randomBytes(8).readBigUInt64BE()
  return value
}
export interface RuntimeHarnessExit { exitCode: number, signal: string | number | null }

/** Own both descriptors before unlinking the private FIFO. No buffered async writer survives a deadline. */
function runtimeInputPipe() {
  const root = mkdtempSync(join(tmpdir(), 'drone-runtime-input-')), path = join(root, 'stdin')
  let staged = -1, reader = -1, writer = -1
  try {
    const result = spawnSync('mkfifo', ['-m', '600', path], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 1000 })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('Runtime input pipe creation failed', { cause: { exitCode: result.status, signal: result.signal, stderr: result.stderr } })
    const before = lstatSync(path)
    if (!before.isFIFO() || before.isSymbolicLink() || before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) throw new Error('Invalid runtime input pipe')
    staged = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    writer = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    reader = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    for (const fd of [staged, writer, reader]) {
      const stat = fstatSync(fd)
      if (!stat.isFIFO() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Runtime input pipe changed while opening')
    }
    closeSync(staged); staged = -1
    rmSync(root, { recursive: true })
    return { reader, writer }
  }
  catch (error) {
    const failures = [error]
    for (const fd of [staged, reader, writer]) if (fd >= 0) {
      try { closeSync(fd) }
      catch (cleanup) { failures.push(cleanup) }
    }
    try { rmSync(root, { recursive: true, force: true }) }
    catch (cleanup) { failures.push(cleanup) }
    if (failures.length > 1) throw new AggregateError(failures, 'Runtime input pipe creation and cleanup failed')
    throw error
  }
}

/** ASCII stepping exists only in the host HAL. Board UART carries raw 64-byte frames. */
export function openRuntimeHarness(artifact: string) {
  const bootId = freshBootId()
  const input = runtimeInputPipe()
  let child: Bun.Subprocess<number, 'pipe', 'pipe'>
  try { child = Bun.spawn([artifact, '--stdio', '--boot-id', bootId.toString(16).padStart(16, '0')], { stdin: input.reader, stdout: 'pipe', stderr: 'pipe' }) }
  catch (error) {
    const failures = [error]
    for (const fd of [input.reader, input.writer]) {
      try { closeSync(fd) }
      catch (cleanup) { failures.push(cleanup) }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Native harness spawn and input cleanup failed')
    throw error
  }
  try { closeSync(input.reader) }
  catch (error) {
    child.kill('SIGKILL')
    try { closeSync(input.writer) }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Native harness reader close and input cleanup failed') }
    throw error
  }
  let inputFd = input.writer
  const reader = child.stdout.getReader()
  const errors = child.stderr.getReader()
  let pending = ''
  let active = false
  let closed = false
  let failed = false
  let closing: Promise<Readonly<RuntimeHarnessExit>> | undefined
  let activeCompletion = Promise.resolve()
  let stderrFinished = false
  const inputFailures: unknown[] = []
  function stopInput() {
    if (inputFd < 0) return
    const fd = inputFd; inputFd = -1
    try { closeSync(fd) }
    catch (error) { inputFailures.push(error) }
  }
  const exited = child.exited.then(exitCode => ({ ok: true, value: Object.freeze({ exitCode, signal: child.signalCode ?? null }) } as const), error => ({ ok: false, error } as const))
  const stderrCompletion = (async () => {
    try {
      while (true) {
        const { value, done } = await errors.read()
        if (done) return
        if (value.length) throw new Error('Native harness produced stderr')
      }
    }
    finally {
      try { await errors.cancel() }
      finally { errors.releaseLock() }
    }
  })().then(() => { stderrFinished = true; return { ok: true } as const }, error => {
    stderrFinished = true
    failed = true
    child.kill('SIGKILL')
    return { ok: false, error } as const
  })
  async function exchange(line: string) {
    if (closed || failed || active || line.length > 150 || line.includes('\n')) throw new Error('Invalid, failed or concurrent harness request')
    active = true
    let finish!: () => void
    activeCompletion = new Promise<void>(resolve => { finish = resolve })
    let timeout: ReturnType<typeof setTimeout>, deadlineHit = false
    let responseCancellation: Promise<{ ok: true } | { ok: false, error: unknown }> | undefined
    const deadlineError = new Error('Native harness response deadline exceeded')
    const deadline = new Promise<{ ok: false, error: Error }>(resolve => {
      timeout = setTimeout(() => {
        deadlineHit = true; failed = true
        child.kill('SIGKILL'); stopInput()
        resolve({ ok: false, error: deadlineError })
        responseCancellation = reader.cancel().then(() => ({ ok: true } as const), error => ({ ok: false, error } as const))
      }, 2000)
    })
    const completion = (async () => {
      const bytes = Buffer.from(`${line}\n`)
      let offset = 0
      while (offset < bytes.length) {
        if (inputFd < 0 || failed) throw new Error('Native harness input closed before delivery')
        try {
          const written = writeSync(inputFd, bytes, offset, bytes.length - offset)
          if (written <= 0) throw new Error('Native harness input made no progress')
          offset += written
        }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw error
          await Bun.sleep(1)
        }
      }
      while (!pending.includes('\n')) {
        const { value, done } = await reader.read()
        if (done) throw new Error('Native harness exited without a response')
        pending += new TextDecoder('utf-8', { fatal: true }).decode(value)
        if (pending.length > 1024) throw new Error('Native harness output exceeded bounds')
      }
      const end = pending.indexOf('\n')
      const hex = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (!/^[a-f\d]{128}$/.test(hex)) throw new Error('Invalid native harness output')
      const frame = decodeRuntimeFrame(Uint8Array.fromHex(hex))
      if (frame.kind !== 'status' || frame.bootId !== bootId) throw new Error('Native harness boot identity rejected')
      return Object.freeze(frame)
    })().then(value => ({ ok: true, value } as const), error => ({ ok: false, error } as const))
    try {
      const outcome = await Promise.race([completion, deadline])
      if (deadlineHit) {
        const stopped = await completion
        const cancellation = await responseCancellation
        const failures: unknown[] = [deadlineError]
        if (!stopped.ok && stopped.error !== deadlineError) failures.push(stopped.error)
        if (cancellation && !cancellation.ok) failures.push(cancellation.error)
        if (failures.length > 1) throw new AggregateError(failures, 'Native harness response deadline exceeded')
        throw deadlineError
      }
      if (!outcome.ok) throw outcome.error
      return outcome.value
    }
    catch (error) { failed = true; child.kill('SIGKILL'); stopInput(); throw error }
    finally {
      active = false; clearTimeout(timeout!)
      if (responseCancellation) await responseCancellation
      finish()
    }
  }
  return {
    get bootId() { return bootId },
    exchange,
    async close(): Promise<Readonly<RuntimeHarnessExit>> {
      if (closing) return closing
      closed = true
      if (active) child.kill('SIGKILL')
      closing = (async () => {
        const failures: unknown[] = []
        const retain = (error: unknown) => { if (!failures.includes(error)) failures.push(error) }
        let timeout: ReturnType<typeof setTimeout>, deadlineHit = false
        const deadline = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            failed = true
            deadlineHit = true
            child.kill('SIGKILL'); stopInput()
            reject(new Error('Native harness close deadline exceeded'))
          }, 1000)
        })
        const completion = (async () => {
          await activeCompletion
          stopInput()
          const exit = await exited
          if (!exit.ok) throw exit.error
          if (inputFailures.length) throw inputFailures[0]
          const stderr = await stderrCompletion
          if (!stderr.ok) throw stderr.error
          const tail = await reader.read()
          if (pending.length || !tail.done) throw new Error('Native harness produced unexpected output while closing')
          return exit.value
        })().then(value => ({ ok: true, value } as const), error => ({ ok: false, error } as const))
        let result: Readonly<RuntimeHarnessExit> | undefined
        try {
          const outcome = await Promise.race([completion, deadline])
          if (outcome.ok) result = outcome.value
          else retain(outcome.error)
        }
        catch (error) { retain(error) }
        finally {
          clearTimeout(timeout!)
          if (failures.length) { failed = true; child.kill('SIGKILL'); stopInput() }
          try { await reader.cancel() }
          catch (error) { retain(error) }
          if (!stderrFinished) {
            try { await errors.cancel() }
            catch (error) { retain(error) }
          }
          await activeCompletion
          const outcome = await completion
          if (!outcome.ok) retain(outcome.error)
          const stderr = await stderrCompletion
          if (!stderr.ok) retain(stderr.error)
          const exit = await exited
          if (!exit.ok) retain(exit.error)
          for (const error of inputFailures) retain(error)
          try { reader.releaseLock() }
          catch (error) { retain(error) }
        }
        if (failures.length > 1) throw new AggregateError(failures, deadlineHit ? 'Native harness close deadline exceeded; cleanup failed' : 'Native harness close and cleanup failed')
        if (failures.length) throw failures[0]
        if (!result) throw new Error('Native harness close result unavailable')
        return result
      })()
      return closing
    },
  }
}
