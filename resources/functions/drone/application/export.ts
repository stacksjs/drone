import type { ApplicationRun } from './runtime-types'
import { createHash } from 'node:crypto'
import { writeCompletedArtifact } from '../../artifacts/completed-directory'
import { nedToGeodetic } from '../estimation/frames'
import { applicationEvidenceLimits, applicationRecordingJson, validateApplicationRun } from './evidence'
import { processApplication } from './coverage'

function hash(bytes: string) { return createHash('sha256').update(bytes, 'utf8').digest('hex') }
function json(value: unknown) { return `${JSON.stringify(value, null, 2)}\n` }
/** Exclusive, private local artifacts. manifest.json is published after content and directory durability barriers. */
export async function writeApplicationDataset(directory: string, input: ApplicationRun): Promise<string> {
  if (typeof directory !== 'string' || directory.length < 1 || directory.length > 4096 || directory.includes('\0')) throw new TypeError('Invalid application dataset directory')
  // Every source value and derived artifact is detached/validated before the first filesystem await.
  const run = validateApplicationRun(input), report = processApplication(run)
  const recording = applicationRecordingJson(run)
  const points = report.cells.map(cell => {
    const [n0, e0, n1, e1] = cell.boundsM
    const positionM: [number, number, number] = [(n0 + n1) / 2, (e0 + e1) / 2, 0]
    const geographic = nedToGeodetic(positionM, run.config.origin)
    return { type: 'Feature', id: cell.id, geometry: { type: 'Point', coordinates: [geographic.longitudeDeg, geographic.latitudeDeg, geographic.ellipsoidHeightM] }, properties: { ...cell, positionM, frame: 'LOCAL_NED', heightDatum: 'WGS84_ELLIPSOID', geometryEvidence: 'grid-centre-point-not-covered-footprint', amountUnit: report.unit } }
  })
  const ledger = { version: 1, evidence: 'recorded-qualified-host-meter-ledger', unit: report.unit, physicalMeasurementVerified: false, rows: run.decisions.map((decision, index) => ({ ...decision, reference: run.inputs[index]!.reference, feedback: run.inputs[index]!.feedback })), limitations: 'Quantized meter/scale ledger replayed from retained qualified host inputs. Estimated positions and measurement uncertainty are separate from independent modeled release/deposition truth. No new host rows are created during the independent neutral tail.' }
  const truth = { version: 1, evidence: 'independent-modeled-plant-truth', unit: report.unit, releases: run.releases, probes: run.probes, final: run.final, shutdown: run.shutdown, inventoryLossSeparateFromEmitted: run.final.unmeteredLossAmount, physicalMeasurementVerified: false }
  const requirements = { version: 1, material: run.config.material, calibration: run.config.calibration, implement: run.config.implement, weather: run.config.weather, weatherLimits: run.config.weatherLimits, localRequirements: run.config.localRequirements, physicalTrialEligible: false, physicalApplicationVerified: false, physicalCalibrationVerified: false, fieldDoseVerified: false, driftVerified: false, hilVerified: false, hardwareInterlocksVerified: false, jurisdictionApprovalVerified: false }
  const entries = [
    { path: 'recording.json', contents: recording },
    { path: 'report.json', contents: json(report) },
    { path: 'cells.geojson', contents: json({ type: 'FeatureCollection', features: points }) },
    { path: 'measured-ledger.json', contents: json(ledger) },
    { path: 'independent-truth.json', contents: json(truth) },
    { path: 'plan.json', contents: json(run.plan) },
    { path: 'requirements.json', contents: json(requirements) },
    { path: 'README.txt', contents: [
      'Drone inert-material application dataset, version 1', '',
      'Software simulation only. Water and inert granules are model materials, not an authorization or qualification for a physical trial.',
      'recording.json retains compact vehicle mission replay and implement decisions with their recorded qualified inputs.',
      'Only three known native uint64 diagnostic IDs are encoded as {$applicationUint64: decimal-string}: authority.bootId/sessionId and board.bootId.',
      'measured-ledger.json contains quantized host meter/scale estimates and their declared uncertainties. These are distinct from independent simulation truth.',
      'independent-truth.json preserves actual modeled plant releases, inventory, cumulative emission, independent probes and neutral-tail closure.',
      'Inventory loss is separate from emitted application material. Emitted material remains conserved across treatable in-field, excluded, outside and in-flight amounts.',
      'report.json uses finite uniform rectangular deposition kernels, oriented by modeled yaw and advected by release wind times fixed fall time.',
      'Coverage is clipped polygon union. Overlap requires distinct apply-* task IDs. Repeated 20 ms stamps of the same pass are not separate passes.',
      'cells.geojson contains grid-centre points with rectangular LOCAL_NED bounds and exact clipped support areas, not full-cell application footprints.',
      'Cell area includes field support. Excluded area is a subset; dose uses remaining treatable support. Prescribed, missed and uncovered support are retained.',
      'Point coordinates are longitude, latitude and WGS84 ellipsoid height. Local coordinates are north/east/down metres at the retained fixed origin.',
      'Host loss creates no new host estimates, decisions or location ledger rows. Independent plant probes/releases can continue during the bounded modeled neutral tail.',
      'Compact replay verifies unsigned recording consistency. Omitted raw sensors, controller/board internals and the entire physics producer are not authenticated or replayed.',
      'Physical calibration, delivery, distribution, dose, drift, hardware barriers, HIL and jurisdiction/material-specific requirements remain unqualified.',
      'manifest.json is the completion marker after private exclusive files and filesystem durability barriers. Hashes identify bytes but are not signatures.',
      'Local hard-link and directory-fsync support is required. Storage hardware power-loss durability has not been tested.', '',
    ].join('\n') },
  ]
  let bytes = 0
  for (const entry of entries) { bytes += Buffer.byteLength(entry.contents); if (bytes > 64 * 1024 * 1024) throw new RangeError('Application dataset resource bound') }
  if (Buffer.byteLength(recording) > applicationEvidenceLimits.recordingBytes) throw new RangeError('Application recording exceeds 16 MiB')
  const manifest = { version: 1, kind: 'inert-material-application-dataset', visitId: run.options.visitId, evidence: run.evidence, status: run.status, reason: run.reason, implement: run.config.implement.type, materialId: run.config.material.id, batch: run.config.material.batch, unit: report.unit, contentAuthentication: 'unsigned-content-hashes', physicalTrialEligible: false, physicalApplicationVerified: false, physicalCalibrationVerified: false, fullSensorReplayPerformed: false, fullPhysicsReplayPerformed: false, clockDomain: 'fixture-monotonic-ms', utcAvailable: false, origin: run.config.origin, localFrame: 'LOCAL_NED', geodeticHeightDatum: 'WGS84_ELLIPSOID', coverageEvidence: report.coverageEvidence, inventoryUnmeteredLossAmount: run.final.unmeteredLossAmount, closureVerifiedEvidence: run.shutdown.evidence, localRequirements: run.config.localRequirements, files: entries.map(entry => ({ path: entry.path, bytes: Buffer.byteLength(entry.contents), sha256: hash(entry.contents) })), persistence: { protocol: 'exclusive-files-and-directory-fsync-before-manifest-link', hardwarePowerLossTested: false } }
  const completed = await writeCompletedArtifact(directory, entries, json(manifest))
  return completed.directory
}
