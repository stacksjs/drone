import { decodeRuntimeFrame } from './protocol'
import { randomBytes } from 'node:crypto'

function freshBootId() {
  let value = 0n
  while (value === 0n) value = randomBytes(8).readBigUInt64BE()
  return value
}
export interface RuntimeHarnessExit { exitCode: number, signal: string | number | null }

/** ASCII stepping exists only in the host HAL. Board UART carries raw 64-byte frames. */
export function openRuntimeHarness(artifact: string) {
  const bootId = freshBootId()
  const child = Bun.spawn([artifact, '--stdio', '--boot-id', bootId.toString(16).padStart(16, '0')], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  const reader = child.stdout.getReader()
  let pending = ''
  let active = false
  let closed = false
  let failed = false
  let closing: Promise<Readonly<RuntimeHarnessExit>> | undefined
  async function exchange(line: string) {
    if (closed || failed || active || line.length > 150 || line.includes('\n')) throw new Error('Invalid, failed or concurrent harness request')
    active = true
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000)
    try {
      child.stdin.write(`${line}\n`)
      await child.stdin.flush()
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
    }
    catch (error) { failed = true; child.kill('SIGKILL'); throw error }
    finally { active = false; clearTimeout(timeout) }
  }
  return {
    get bootId() { return bootId },
    exchange,
    async close(): Promise<Readonly<RuntimeHarnessExit>> {
      if (closing) return closing
      closed = true
      if (active) child.kill('SIGKILL')
      closing = (async () => {
        let inputFailed = false, inputError: unknown
        try { child.stdin.end() }
        catch (error) { inputFailed = true; inputError = error; child.kill('SIGKILL') }
        const timeout = setTimeout(() => child.kill('SIGKILL'), 1000)
        try {
          const exitCode = await child.exited
          if (inputFailed) throw inputError
          return Object.freeze({ exitCode, signal: child.signalCode ?? null })
        }
        finally {
          clearTimeout(timeout)
          try { await reader.cancel() }
          finally { reader.releaseLock() }
        }
      })()
      return closing
    },
  }
}
