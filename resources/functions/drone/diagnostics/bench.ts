import type { RuntimeBenchFault } from '../runtime/bench'
import type { DiagnosticEvent } from './types'
import type { DiagnosticsRecorder } from './recorder'
import { join, resolve } from 'node:path'
import { runRuntimeBench } from '../runtime/bench'
import { decodeRuntimeFrame, runtimeProtocol } from '../runtime/protocol'
import { openDiagnosticsRecorder } from './recorder'
import { hashDiagnostic, recordRuntimeFrame, parseDiagnosticsJournal } from './journal'
import { readDiagnosticsFile } from './files'
import { diagnoseDiagnostics } from './replay'

/** Actual native host HAL transcript; virtual board epochs, not hardware timing evidence. */
export async function recordRuntimeDiagnostics(options: { directory: string, project?: string, ticks?: number, fault?: RuntimeBenchFault }) {
  let recorder: DiagnosticsRecorder | null = null
  const project = resolve(options.project ?? process.cwd()), ticks = options.ticks ?? 1000, fault = options.fault ?? 'deadline'
  try {
    const bench = await runRuntimeBench({ project, ticks, fault,
      async onBuild(artifact) {
        recorder = await openDiagnosticsRecorder({ directory: options.directory, evidence: 'host-harness', provenance: {
          firmwareSha256: await hashDiagnostic(new Uint8Array(await Bun.file(artifact).arrayBuffer())),
          configurationSha256: await hashDiagnostic(JSON.stringify({ ticks, fault, runtimeProtocol })),
          modelSha256: await hashDiagnostic(await Bun.file(join(project, 'firmware/runtime/include/runtime.hpp')).text()),
          calibrationSha256: await hashDiagnostic('not-applicable:synthetic-runtime-sample-v1'), runtimeProtocol: 1,
        } })
      },
      async onRequest(line, atMs) {
        if (!recorder) throw new Error('Diagnostic recorder unavailable')
        if (line.startsWith('tick ')) recorder.append({ kind: 'tick', boardUs: line.slice(5) }, atMs)
        else {
          let event: DiagnosticEvent
          try { event = { kind: 'runtime', direction: 'tx', frame: recordRuntimeFrame(decodeRuntimeFrame(Uint8Array.fromHex(line.slice(6)))) } }
          catch { event = { kind: 'health', code: 'protocol-rejected' } }
          recorder.append(event, atMs)
        }
        await recorder.flush({ sync: false })
      },
      async onStatus(status, atMs) {
        if (!recorder) throw new Error('Diagnostic recorder unavailable')
        recorder.append({ kind: 'runtime', direction: 'rx', frame: recordRuntimeFrame(status) }, atMs)
        await recorder.flush({ sync: false })
      },
    })
    if (!recorder) throw new Error('Diagnostic recorder was not initialized')
    // TypeScript does not track assignments made inside the onBuild callback.
    const active = recorder as DiagnosticsRecorder
    await active.close()
    recorder = null
    const journal = await parseDiagnosticsJournal(await readDiagnosticsFile(active.path))
    return { bench, path: active.path, diagnostics: diagnoseDiagnostics(journal) }
  }
  catch (error) {
    const active = recorder as DiagnosticsRecorder | null
    if (active?.stats().accepting) {
      active.append({ kind: 'health', code: 'host-error' }, active.stats().lastAtMs)
      await active.close('host-error').catch(() => {})
    }
    throw error
  }
}
