import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { importGridSurface, importPlySurface } from '../../resources/functions/drone/volumes/import'
import { importGeoTiffSurface } from '../../resources/functions/drone/volumes/geotiff'
import { readGeoTiffFile, readLasFile } from '../../resources/functions/drone/volumes/files'
import { importLasSurface } from '../../resources/functions/drone/volumes/las'
import { processStockpile, validateSurfaceMetadata, validateVolumeRequest } from '../../resources/functions/drone/volumes/engine'
import { writeVolumeDataset } from '../../resources/functions/drone/volumes/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

const lasDiagnosticCodes = new Set([
  'las-surface-input', 'las-surface-budget', 'las-surface-unavailable',
  'las-surface-no-supported-cells', 'las-source-sha256-mismatch',
  'las-file-unavailable', 'las-dataset-source-input', 'las-dataset-source-mismatch',
])
function lasDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return lasDiagnosticCodes.has(message) ? message : 'las-import-unavailable'
}

function parseDocument(text: string): unknown {
  try { return JSON.parse(text) }
  catch { throw new TypeError('Invalid surface metadata or measurement JSON') }
}
export default defineCommand({
  name: 'volumes:import <surface>',
  description: 'Import ASC, indexed PLY, declared GeoTIFF or a declared LAS point grid with a measurement contract',
  options: {
    '--format <name>': 'Required: asc, ply, geotiff or las',
    '--metadata <path>': 'Surface metadata for asc/ply, or a wrapped declaration for geotiff/las',
    '--measurement <path>': 'Required JSON: version, id, boundary, base and reference',
    '--output <directory>': 'New private audit dataset',
  },
  async handle(options, path) {
    try {
      const geotiff = options.format === 'geotiff'
      const las = options.format === 'las'
      if (!['asc', 'ply', 'geotiff', 'las'].includes(options.format ?? '') || !options.metadata || !options.measurement) throw new TypeError('Specify --format asc|ply|geotiff|las, --metadata and --measurement')
      const metadata = geotiff || las
        ? await readMissionFile(options.metadata, { preserveBom: true, maxBytes: 32768 })
        : validateSurfaceMetadata(parseDocument(await readMissionFile(options.metadata)))
      const measurement = parseDocument(await readMissionFile(options.measurement))
      if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement) || Object.keys(measurement).length !== 5 || Object.keys(measurement).some(key => !['version', 'id', 'boundary', 'base', 'reference'].includes(key))) throw new TypeError('Measurement must declare exactly version, id, boundary, base and reference')
      const lasBytes = las ? await readLasFile(path) : null
      const lasImport = lasBytes && typeof metadata === 'string' ? await importLasSurface(lasBytes, metadata) : null
      const surface = lasImport ? lasImport.surface : typeof metadata === 'string'
        ? await importGeoTiffSurface(await readGeoTiffFile(path), metadata)
        : options.format === 'asc'
          ? await importGridSurface(await readMissionFile(path, { preserveBom: true }), metadata)
          : await importPlySurface(await readMissionFile(path, { preserveBom: true }), metadata)
      const request = validateVolumeRequest({ ...measurement, surface })
      const { integrationPieces, ...report } = processStockpile(request)
      const dataset = options.output ? await writeVolumeDataset(options.output, request, lasBytes && typeof metadata === 'string' ? { format: 'las', bytes: lasBytes, declarationJson: metadata } : undefined) : null
      const sourceProcessing = lasImport ? Object.fromEntries(Object.entries(lasImport.processing).filter(([key]) => key !== 'cells')) : null
      await printAsync(JSON.stringify({ report, contributionCount: integrationPieces.length, dataset, ...(sourceProcessing ? { sourceProcessing } : {}) }, null, 2))
    }
    catch (error) {
      process.exitCode = 1
      try { await printErrorAsync(options.format === 'las' ? lasDiagnostic(error) : error instanceof Error ? error.message : 'Volume import unavailable') }
      catch { /* Preserve failure when the diagnostic pipe is closed. */ }
    }
  },
})
