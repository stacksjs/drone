import { resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import { writeCompletedArtifact } from '../../artifacts/completed-directory'
import type { EnvironmentRun } from './runtime'
import { environmentSummary, simulateEnvironment, validateEnvironmentRun } from './runtime'
import { compact, environmentLimits, normalizeEnvironmentInput, sha256, unavailable } from './plan'
import { environmentHeldOut } from './sensor'

export function environmentOutputDirectory(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096 || input.includes('\0')) return unavailable()
  const directory = resolve(input)
  if (directory.length > 4096 || Buffer.byteLength(compact(directory)) > 8192) return unavailable()
  return directory
}
function encoded(value: unknown, bytes: number): string {
  const text = compact(value) + '\n'
  if (Buffer.byteLength(text) > bytes) return unavailable()
  return text
}
/** Pure wire preparation also serves bounded negative tests; the writer never accepts a caller run. */
export function encodeEnvironmentDataset(run: EnvironmentRun) {
  validateEnvironmentRun(run)
  const version = Bun.version, revision = Bun.revision
  if (typeof version !== 'string' || version.length > 64 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) || typeof revision !== 'string' || !/^[a-f0-9]{7,64}$/.test(revision)) return unavailable()
  const diagnosticText = run.diagnostics.map(row => encoded(row, environmentLimits.diagnosticRow)).join('')
  const packetText = run.packets.map(row => encoded(row, environmentLimits.packetRow)).join('')
  const observationText = run.observations.map((observation, i) => encoded({ observation, link: run.custody[i] }, environmentLimits.observationRow)).join('')
  if (Buffer.byteLength(diagnosticText) > environmentLimits.diagnosticsBytes || Buffer.byteLength(packetText) > environmentLimits.packetsBytes || Buffer.byteLength(observationText) > environmentLimits.observationsBytes) return unavailable()
  const entries = [
    { path: 'mission.json', contents: encoded(run.trace, environmentLimits.traceBytes) },
    { path: 'diagnostics.ndjson', contents: diagnosticText },
    { path: 'packets.ndjson', contents: packetText },
    { path: 'observations.ndjson', contents: observationText },
  ]
  const records = [run.trace.rows.length, run.diagnostics.length, run.packets.length, run.observations.length]
  const files = entries.map((entry, i) => ({ path: entry.path, byteLength: Buffer.byteLength(entry.contents), sha256: sha256(entry.contents), records: records[i]! }))
  const manifest = {
    version: 1, evidence: run.evidence, profile: run.profile, contentAuthentication: 'unsigned-content-hashes',
    persistence: { protocol: 'exclusive-files-and-directory-fsync-before-manifest-link', hardwarePowerLossTested: false, completionAcknowledgement: 'not-encoded-in-manifest' },
    engine: { name: 'Bun', version, revision }, model: run.model, calibration: run.calibration, heldOut: environmentHeldOut,
    policy: run.policy, mission: run.mission, counts: run.counts, fault: run.fault, retirement: run.retirement,
    custody: { count: run.custody.length, firstSha256: run.custody[0]?.sha256 ?? null, lastSha256: run.custody.at(-1)?.sha256 ?? null }, summary: environmentSummary(run), files,
  }
  const manifestJson = encoded(manifest, environmentLimits.metadataBytes)
  const bytes = files.reduce((sum, file) => sum + file.byteLength, Buffer.byteLength(manifestJson))
  if (bytes > environmentLimits.totalBytes) return unavailable()
  return { entries, manifest, manifestJson, bytes, manifestSha256: sha256(manifestJson) }
}
/** Fresh owned run, full preflight, then unchanged exclusive completed-directory protocol. */
export async function writeEnvironmentDataset(output: unknown, input: unknown = {}) {
  const directory = environmentOutputDirectory(output), options = normalizeEnvironmentInput(input)
  const run = simulateEnvironment(options), encodedRun = encodeEnvironmentDataset(run)
  const receipt = { directory, manifestSha256: encodedRun.manifestSha256, files: 5 as const, bytes: encodedRun.bytes }
  environmentSummary(run, receipt)
  const published = await writeCompletedArtifact(directory, encodedRun.entries, encodedRun.manifestJson)
  if (published.directory !== directory) return unavailable()
  return { summary: environmentSummary(run, receipt) }
}
