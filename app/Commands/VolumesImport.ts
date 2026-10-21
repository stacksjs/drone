import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { importGridSurface, importPlySurface } from '../../resources/functions/drone/volumes/import'
import { importGeoTiffSurface } from '../../resources/functions/drone/volumes/geotiff'
import { readGeoTiffFile } from '../../resources/functions/drone/volumes/files'
import { processStockpile, validateSurfaceMetadata, validateVolumeRequest } from '../../resources/functions/drone/volumes/engine'
import { writeVolumeDataset } from '../../resources/functions/drone/volumes/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

function parseDocument(text: string): unknown {
  try { return JSON.parse(text) }
  catch { throw new TypeError('Invalid surface metadata or measurement JSON') }
}
export default defineCommand({
  name: 'volumes:import <surface>',
  description: 'Import an ASC grid, indexed ASCII PLY or declared numeric GeoTIFF with a measurement contract',
  options: {
    '--format <name>': 'Required: asc, ply or geotiff',
    '--metadata <path>': 'Surface metadata for asc/ply, or a wrapped elevation declaration for geotiff',
    '--measurement <path>': 'Required JSON: version, id, boundary, base and reference',
    '--output <directory>': 'New private audit dataset',
  },
  async handle(options, path) {
    try {
      const geotiff = options.format === 'geotiff'
      if ((!geotiff && !['asc', 'ply'].includes(options.format ?? '')) || !options.metadata || !options.measurement) throw new TypeError('Specify --format asc|ply, --metadata and --measurement')
      const metadata = geotiff
        ? await readMissionFile(options.metadata, { preserveBom: true, maxBytes: 32768 })
        : validateSurfaceMetadata(parseDocument(await readMissionFile(options.metadata)))
      const measurement = parseDocument(await readMissionFile(options.measurement))
      if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement) || Object.keys(measurement).length !== 5 || Object.keys(measurement).some(key => !['version', 'id', 'boundary', 'base', 'reference'].includes(key))) throw new TypeError('Measurement must declare exactly version, id, boundary, base and reference')
      const surface = typeof metadata === 'string'
        ? await importGeoTiffSurface(await readGeoTiffFile(path), metadata)
        : options.format === 'asc'
          ? await importGridSurface(await readMissionFile(path, { preserveBom: true }), metadata)
          : await importPlySurface(await readMissionFile(path, { preserveBom: true }), metadata)
      const request = validateVolumeRequest({ ...measurement, surface })
      const { integrationPieces, ...report } = processStockpile(request)
      const dataset = options.output ? await writeVolumeDataset(options.output, request) : null
      print(JSON.stringify({ report, contributionCount: integrationPieces.length, dataset }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
