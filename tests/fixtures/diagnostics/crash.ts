/** Real process termination fixture. Its log is fsynced before readiness and has no completion footer. */
import { openDiagnosticsRecorder } from '../../../resources/functions/drone/diagnostics/recorder'
const writer = await openDiagnosticsRecorder({ directory: process.argv[2]!, evidence: 'fixture', provenance: { firmwareSha256: '1'.repeat(64), configurationSha256: '2'.repeat(64), modelSha256: '3'.repeat(64), calibrationSha256: '4'.repeat(64), runtimeProtocol: 1 } })
writer.append({ kind: 'health', code: 'transport-loss' }, 10)
await writer.flush()
process.stdout.write('ready\n')
setInterval(() => {}, 1000)
