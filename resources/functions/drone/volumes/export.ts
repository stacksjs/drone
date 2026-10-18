import type { VolumeRequest } from './types'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeCompletedArtifact } from '../../artifacts/completed-directory'
import { processStockpile, validateVolumeRequest } from './engine'
import { exportGridSurface, exportPlySurface } from './import'

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function digest(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex')
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Recompute and publish an exclusive, completion-marked numerical dataset. Server only. */
export async function writeVolumeDataset(directory: string, input: VolumeRequest): Promise<{ directory: string, manifest: string, report: string, contributions: string, manifestSha256: string }> {
  const request = validateVolumeRequest(input)
  const report = processStockpile(request)
  const sourcePath = request.surface.geometry.kind === 'cell-grid' ? 'surface.asc' : 'surface.ply'
  const sourceText = request.surface.geometry.kind === 'cell-grid' ? exportGridSurface(request.surface) : exportPlySurface(request.surface)
  const regeneratedSourceSha256 = digest(sourceText)
  const sidecar = structuredClone(request.surface.metadata)
  sidecar.provenance.sourceSha256 = regeneratedSourceSha256
  const columns = ['sourceId', 'boundaryPart', 'weight', 'areaM2', 'aboveBaseM3', 'belowBaseM3', 'signedTopMinusBaseM3', 'polygonEastNorthM']
  const contributions = `${[columns.join(','), ...report.integrationPieces.map(piece => [piece.sourceId, piece.boundaryPart, piece.weight, piece.areaM2, piece.aboveBaseM3, piece.belowBaseM3, piece.signedTopMinusBaseM3, JSON.stringify(piece.polygonM)].map(csvCell).join(','))].join('\n')}\n`
  const entries = [
    { path: 'request.json', contents: json(request) },
    { path: 'report.json', contents: json(report) },
    { path: 'contributions.csv', contents: contributions },
    { path: sourcePath, contents: sourceText },
    { path: 'surface.metadata.json', contents: json(sidecar) },
  ]
  const manifest = {
    version: 1,
    kind: 'stockpile-volume-dataset',
    requestId: request.id,
    surfaceId: request.surface.metadata.id,
    evidence: report.evidence,
    method: report.method,
    physicalActuationEnabled: false,
    acquisitionPerformed: false,
    reconstructionPerformed: false,
    physicalAccuracyVerified: false,
    originalSourceSha256: request.surface.metadata.provenance.sourceSha256,
    regeneratedSourceSha256,
    sourcePath,
    metadataPath: 'surface.metadata.json',
    files: entries.map(entry => ({ path: entry.path, bytes: new TextEncoder().encode(entry.contents).byteLength, sha256: digest(entry.contents) })),
    policy: {
      coordinates: 'Easting, northing, elevation up in declared metre-based reference. No CRS or vertical datum conversion.',
      surfaceRepresentation: request.surface.geometry.kind === 'cell-grid' ? 'Piecewise-constant cell elevations; corner-origin, north-first AAIGrid; nodata remains missing.' : 'Indexed single-valued triangular terrain surface; ASCII PLY; no raw-point triangulation.',
      signedConvention: 'Top minus plane base, integrated over horizontal covered area. Above and below volumes are nonnegative; signed is above minus below.',
      boundaryWeights: 'Audit pieces carry outer-ring weight +1 and hole weight -1. Apply weight to area and volume fields when independently summing the contribution table.',
      gaps: 'No interpolation, extrapolation or percentage scaling. Full-boundary volume remains unknown when meaningful coverage gaps exist.',
      sourceIntegrity: 'Sidecar SHA256 binds regenerated exact UTF-8 source bytes. The original source identity remains in request.json and this manifest. Hashes establish consistency, not survey authenticity.',
      accuracy: 'Conditional declared vertical bounds do not establish overall field accuracy; acquisition, reconstruction, classification and independent physical survey evidence remain separate.',
      completion: 'manifest.json is the completion marker written after private exclusive files and filesystem durability barriers.',
    },
  }
  const manifestJson = json(manifest)
  const published = await writeCompletedArtifact(directory, entries, manifestJson)
  return { ...published, report: join(published.directory, 'report.json'), contributions: join(published.directory, 'contributions.csv'), manifestSha256: digest(manifestJson) }
}
