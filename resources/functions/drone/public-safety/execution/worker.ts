import type { ExecutionWorkerInput, ExecutionWorkerMessage } from './protocol'
import { simulatePublicSafety } from '../runtime'
import { publicSafetyRecordingData } from '../evidence'
import { executionDigest, executionWords as words } from './protocol'

declare const self: Worker & { close: () => void }
/** Thin app Worker bootstrap invokes this once. No Auth/ORM, request or private file input. */
export function runPublicSafetyWorker(): void {
  self.onmessage = ({ data }: MessageEvent<ExecutionWorkerInput>) => {
    // There is exactly one producer invocation. Later start messages cannot run work.
    self.onmessage = null
    let outcome: 'completed' | 'canceled' | 'failed' | 'refused' = 'failed', transferred = false
    let control: Int32Array | undefined
    const send = (message: ExecutionWorkerMessage, transfer?: Transferable[]) => self.postMessage(message, transfer ?? [])
    try {
      if (data.version !== 1 || !(data.control instanceof SharedArrayBuffer) || data.control.byteLength !== words.length * 4 || !Number.isSafeInteger(data.creditWaitMs) || data.creditWaitMs < 1 || Object.keys(process.env).length) throw new Error('Invalid owned Worker bootstrap')
      for (const name of ['Auth', 'db', 'getCurrentRequest', 'request']) if ((globalThis as Record<string, unknown>)[name] !== undefined) throw new Error('Application authority entered the Worker')
      control = new Int32Array(data.control)
      const canceled = () => Atomics.load(control!, words.cancel) !== 0
      const run = simulatePublicSafety({ config: data.config, scenario: data.scenario, seconds: data.seconds, onEvent(event) {
        if (canceled()) throw new Error('Owned producer canceled')
        Atomics.store(control!, words.emitted, event.sequence)
        send({ version: 1, kind: 'event', event })
        const until = performance.now() + data.creditWaitMs
        while (Atomics.load(control!, words.credit) < event.sequence) {
          if (canceled() || performance.now() >= until) throw new Error('Owned producer credit ended')
          Atomics.wait(control!, words.credit, Atomics.load(control!, words.credit), Math.min(50, Math.max(1, until - performance.now())))
        }
        if (canceled()) throw new Error('Owned producer canceled')
      } })
      Atomics.store(control, words.returned, 1)
      if (canceled()) throw new Error('Owned producer canceled')
      // This marker brackets the canonical call, not cancellation inside its instructions.
      Atomics.store(control, words.stage, 2)
      const canonical = publicSafetyRecordingData(run)
      Atomics.store(control, words.stage, 3)
      if (canceled()) throw new Error('Owned producer canceled')
      const encoded = new TextEncoder().encode(canonical), buffer = new ArrayBuffer(encoded.byteLength), view = new Uint8Array(buffer)
      view.set(encoded)
      const digest = executionDigest(view), byteLength = buffer.byteLength
      if (canceled()) throw new Error('Owned producer canceled')
      send({ version: 1, kind: 'result', buffer, digest, byteLength }, [buffer])
      transferred = buffer.byteLength === 0 && view.byteLength === 0
      if (!transferred) throw new Error('Owned result transfer did not detach')
      outcome = 'completed'
    }
    catch (error) {
      outcome = control && Atomics.load(control, words.cancel) ? 'canceled' : error instanceof TypeError && error.message.includes('source exceeds 16 MiB') ? 'refused' : 'failed'
      transferred = false
    }
    finally {
      // All producer, canonicalization, encoding and transfer work has ended before ACK.
      // close marks termination; neither this ACK nor close claims an OS thread join.
      send({ version: 1, kind: 'finished', outcome, transferred })
      self.close()
    }
  }
}
