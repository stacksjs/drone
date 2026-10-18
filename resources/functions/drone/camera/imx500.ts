import type { CameraFrame } from './types'
import { fileURLToPath } from 'node:url'
import { parseCameraPacket } from './protocol'

export interface CameraSourceCallbacks {
  onFrame: (frame: CameraFrame, image: string | null) => void
  onError: (message: string) => void
}
export interface CameraSource { close: () => void }

/** Hardware acquisition only. Target policy remains in tracker.ts. No shell is invoked. */
export function startImx500(callbacks: CameraSourceCallbacks): CameraSource {
  const worker = fileURLToPath(new URL('./imx500_worker.py', import.meta.url))
  const python = process.env.DRONE_CAMERA_PYTHON ?? '/usr/bin/python3'
  const child = Bun.spawn([python, '-u', worker], { stdout: 'pipe', stderr: 'inherit', stdin: 'ignore' })
  let stopped = false
  let termination: ReturnType<typeof setTimeout> | undefined
  function terminate() {
    child.kill()
    termination = setTimeout(() => { child.kill('SIGKILL') }, 1000)
    termination.unref()
  }
  function fail(message: string) {
    if (stopped) return
    stopped = true
    terminate()
    callbacks.onError(message)
  }
  void (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let pending = ''
    try {
      while (!stopped) {
        const { value, done } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        if (pending.length > 1000000) throw new RangeError('Camera worker exceeded packet limit')
        let newline
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (!line) continue
          const now = performance.now()
          const { frame, image } = parseCameraPacket(JSON.parse(line), now, Number(process.hrtime.bigint()) / 1000000)
          callbacks.onFrame(frame, image)
        }
      }
      if (!stopped) fail('Camera worker ended; inspect Pi diagnostics and restart explicitly')
    }
    catch {
      fail('Camera worker failed or supplied invalid/stale inference; restart explicitly')
    }
    finally { reader.releaseLock() }
  })()
  void child.exited.then(code => {
    if (termination) clearTimeout(termination)
    if (!stopped) fail(`Camera worker exited (${code}); inspect Pi diagnostics`)
  })
  return { close() { if (!stopped) { stopped = true; terminate() } } }
}
