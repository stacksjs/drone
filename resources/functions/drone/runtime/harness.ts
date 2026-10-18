import { decodeRuntimeFrame } from './protocol'

/** ASCII stepping exists only in the host HAL. Board UART carries raw 64-byte frames. */
export function openRuntimeHarness(artifact: string) {
  const child = Bun.spawn([artifact, '--stdio'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  const reader = child.stdout.getReader()
  let pending = ''
  let active = false
  let closed = false
  async function exchange(line: string) {
    if (closed || active || line.length > 150 || line.includes('\n')) throw new Error('Invalid or concurrent harness request')
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
      return decodeRuntimeFrame(Uint8Array.fromHex(hex))
    }
    finally { active = false; clearTimeout(timeout) }
  }
  return {
    exchange,
    async close() {
      if (closed) return
      closed = true
      child.stdin.end()
      const timeout = setTimeout(() => child.kill('SIGKILL'), 1000)
      try { await child.exited }
      finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); reader.releaseLock() }
    },
  }
}
