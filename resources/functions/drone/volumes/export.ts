import type { VolumeRequest } from './types'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeCompletedArtifact } from '../../artifacts/completed-directory'
import { processStockpile, validateVolumeRequest } from './engine'
import { exportGridSurface, exportPlySurface } from './import'
import { importLasSurface } from './las'
import { captureSurfaceBytes } from './bytes'

export interface LasVolumeImportSource { format: 'las', bytes: Uint8Array, declarationJson: string }
function captureLasSource(input: LasVolumeImportSource) {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 3) throw new TypeError()
    const values: unknown[] = ['format', 'bytes', 'declarationJson'].map(key => {
      const d = Object.getOwnPropertyDescriptor(input, key)
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw new TypeError()
      return d.value
    })
    if (values[0] !== 'las' || typeof values[2] !== 'string' || values[2].length > 32768) throw new TypeError()
    return { bytes: captureSurfaceBytes(values[1]), declarationJson: values[2] }
  }
  catch { throw new TypeError('las-dataset-source-input') }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function digest(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Recompute and publish an exclusive, completion-marked numerical dataset. Server only. */
export async function writeVolumeDataset(directory: string, input: VolumeRequest, importSource?: LasVolumeImportSource): Promise<{ directory: string, manifest: string, report: string, contributions: string, manifestSha256: string }> {
  const request = validateVolumeRequest(input)
  const capturedSource = importSource === undefined ? null : captureLasSource(importSource)
  const proof = capturedSource ? await importLasSurface(capturedSource.bytes, capturedSource.declarationJson) : null
  if (proof && JSON.stringify(proof.surface) !== JSON.stringify(request.surface)) throw new Error('las-dataset-source-mismatch')
  const report = processStockpile(request)
  const sourcePath = request.surface.geometry.kind === 'cell-grid' ? 'surface.asc' : 'surface.ply'
  const sourceText = request.surface.geometry.kind === 'cell-grid' ? exportGridSurface(request.surface) : exportPlySurface(request.surface)
  const regeneratedSourceSha256 = digest(sourceText)
  const sidecar = structuredClone(request.surface.metadata)
  sidecar.provenance.sourceSha256 = regeneratedSourceSha256
  const columns = ['sourceId', 'boundaryPart', 'weight', 'areaM2', 'aboveBaseM3', 'belowBaseM3', 'signedTopMinusBaseM3', 'polygonEastNorthM']
  const contributions = `${[columns.join(','), ...report.integrationPieces.map(piece => [piece.sourceId, piece.boundaryPart, piece.weight, piece.areaM2, piece.aboveBaseM3, piece.belowBaseM3, piece.signedTopMinusBaseM3, JSON.stringify(piece.polygonM)].map(csvCell).join(','))].join('\n')}\n`
  const entries: { path: string, contents: string | Uint8Array }[] = [
    { path: 'request.json', contents: json(request) },
    { path: 'report.json', contents: json(report) },
    { path: 'contributions.csv', contents: contributions },
    { path: sourcePath, contents: sourceText },
    { path: 'surface.metadata.json', contents: json(sidecar) },
  ]
  if (capturedSource && proof) entries.push(
    { path: 'source.las', contents: capturedSource.bytes },
    { path: 'source.declaration.json', contents: capturedSource.declarationJson },
    { path: 'source.gridding.json', contents: json(proof.processing) },
  )
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
    ...(proof ? { sourceProcessing: { format: 'las', originalSourcePath: 'source.las', declarationPath: 'source.declaration.json', processingPath: 'source.gridding.json', method: proof.processing.method, representationErrorBoundM: null, classificationVerified: false } } : {}),
    files: entries.map(entry => ({ path: entry.path, bytes: typeof entry.contents === 'string' ? new TextEncoder().encode(entry.contents).byteLength : entry.contents.byteLength, sha256: digest(entry.contents) })),
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
