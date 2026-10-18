import { diagnosticLimits } from './types'
import { parseDiagnosticsJournal } from './journal'
/** The selected file stays in this tab. No upload, telemetry transport or persistent browser storage. */
export async function loadDiagnosticFile(file: Pick<File, 'size' | 'text'>) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > diagnosticLimits.fileBytes) throw new RangeError('Choose a diagnostic journal up to 4 MiB')
  return parseDiagnosticsJournal(await file.text())
}
