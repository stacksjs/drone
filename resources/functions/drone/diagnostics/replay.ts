import type { DiagnosticJournal, RecordedRuntimeFrame } from './types'
import { diagnosticTime } from './journal'
import { runtimeFlags, runtimeProtocol } from '../runtime/protocol'

/** Pure diagnostic projection of verified records, never a transport or authority session. */
export function createDiagnosticsReplay(input: DiagnosticJournal) {
  const journal = structuredClone(input)
  let cursor = 0, now = 0, latest: RecordedRuntimeFrame | null = null, receivedAtMs: number | null = null, commands = 0, boots = 0, wireGaps = 0, replayedStatus = 0
  const statusHighWater = new Map<string, { sequence: number, boardUs: bigint }>()
  const health = new Set<string>(), transitions: { atMs: number, code: string }[] = []
  function event(atMs: number, code: string) { if (!health.has(code)) { health.add(code); transitions.push({ atMs, code }) } }
  function snapshot() {
    return structuredClone({ nowMs: now, consumed: cursor, total: journal.events.length, durationMs: journal.footer?.atMs ?? journal.events.at(-1)?.atMs ?? 0, completion: journal.completion, loss: journal.loss, evidence: journal.header.evidence, latest, statusAgeMs: receivedAtMs === null ? null : now - receivedAtMs, statusStale: receivedAtMs === null || now - receivedAtMs > runtimeProtocol.freshnessUs / 1000, commands, bootSegments: boots, wireGaps, replayedStatus, health: [...health], transitions, physicalFlightEnabled: false as const })
  }
  return {
    snapshot,
    advanceTo(atMs: number) {
      diagnosticTime(atMs)
      if (atMs < now) throw new RangeError('Replay must advance monotonically; create a fresh replay to seek backwards')
      while (cursor < journal.events.length && journal.events[cursor]!.atMs <= atMs) {
        const { event: e, atMs: at } = journal.events[cursor++]!
        if (e.kind === 'health') event(at, e.code)
        if (e.kind === 'runtime' && e.direction === 'tx') commands++
        if (e.kind === 'runtime' && e.direction === 'rx') {
          const f = e.frame
          if (!latest || f.bootId !== latest.bootId) { boots++; if (latest) event(at, 'boot-change') }
          const high = statusHighWater.get(f.bootId), boardUs = BigInt(f.sampleTimeUs)
          if (high && f.sequence <= high.sequence) { replayedStatus++; event(at, 'status-replay') }
          else {
            if (high) {
              wireGaps += f.sequence - high.sequence - 1
              if (boardUs < high.boardUs) event(at, 'board-clock-reversal')
            }
            statusHighWater.set(f.bootId, { sequence: f.sequence, boardUs: high && high.boardUs > boardUs ? high.boardUs : boardUs })
          }
          if (f.bootId === '0' || f.sequence === 0) event(at, 'invalid-runtime-identity')
          if (!(f.flags & runtimeFlags.sampleValid) || f.ticks === 0) event(at, 'runtime-sample-invalid')
          if (f.stateBytes < 1 || f.stateBytes > 128) event(at, 'runtime-state-bounds')
          if (f.leaseUs > runtimeProtocol.maxLeaseUs || Boolean(f.flags & runtimeFlags.leased) !== (f.leaseUs > 0)) event(at, 'lease-inconsistent')
          if (f.deadlineMisses || f.flags & runtimeFlags.deadlineFault || f.maxExecutionUs > runtimeProtocol.deadlineUs) event(at, 'deadline-miss')
          if (f.flags & runtimeFlags.clockFault) event(at, 'clock-discontinuity')
          if (f.flags & runtimeFlags.watchdogReset) event(at, 'watchdog-reset')
          if (!(f.flags & runtimeFlags.neutralOnly)) event(at, 'neutral-profile-missing')
          if (f.flags & ~127) event(at, 'unknown-runtime-flags')
          latest = f; receivedAtMs = at
        }
      }
      now = atMs
      return snapshot()
    },
  }
}
export type DiagnosticsReplaySnapshot = ReturnType<ReturnType<typeof createDiagnosticsReplay>['snapshot']>
export function diagnoseDiagnostics(journal: DiagnosticJournal) {
  const replay = createDiagnosticsReplay(journal), result = replay.advanceTo(journal.footer?.atMs ?? journal.events.at(-1)?.atMs ?? 0)
  const checks = [
    { id: 'completion', state: journal.completion === 'completed' ? 'pass' : 'fail', detail: journal.completion },
    { id: 'record-loss', state: journal.loss.tailUnknown || journal.loss.knownDropped > 0 ? 'fail' : 'pass', detail: journal.loss.tailUnknown ? 'tail-unknown' : String(journal.loss.knownDropped) },
    { id: 'runtime-status', state: result.latest && !result.statusStale ? 'pass' : 'fail', detail: result.latest ? (result.statusStale ? 'stale' : 'recorded') : 'missing' },
    { id: 'runtime-health', state: result.health.length || result.replayedStatus || result.wireGaps ? 'fail' : 'pass', detail: result.health.join(', ') || (result.wireGaps ? 'status-gaps' : 'no-observed-fault') },
    { id: 'physical-commissioning', state: 'blocked', detail: 'independent-hardware-evidence-required' },
    { id: 'signed-update-rollback', state: 'blocked', detail: 'not-implemented' },
  ] as const
  return { version: 1, runId: journal.header.runId, evidence: journal.header.evidence, verifiedHash: journal.verifiedHash, checks, diagnosticFailures: checks.filter(check => check.state === 'fail').length, commissioningReady: false as const, replay: result, physicalFlightEnabled: false as const }
}
