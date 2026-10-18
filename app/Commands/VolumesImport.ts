import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { importGridSurface, importPlySurface } from '../../resources/functions/drone/volumes/import'
import { processStockpile, validateSurfaceMetadata, validateVolumeRequest } from '../../resources/functions/drone/volumes/engine'
import { writeVolumeDataset } from '../../resources/functions/drone/volumes/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

function parseDocument(text: string): unknown {
  try { return JSON.parse(text) }
  catch { throw new TypeError('Invalid surface metadata or measurement JSON') }
}
export default defineCommand({
  name: 'volumes:import <surface>',
  description: 'Import a known ASC cell grid or indexed ASCII PLY with exact source metadata and a measurement contract',
  options: {
    '--format <name>': 'Required: asc or ply',
    '--metadata <path>': 'Required surface metadata JSON with matching exact UTF-8 source SHA256',
    '--measurement <path>': 'Required JSON: version, id, boundary, base and reference',
    '--output <directory>': 'New private audit dataset',
  },
  async handle(options, path) {
    try {
      if (!['asc', 'ply'].includes(options.format ?? '') || !options.metadata || !options.measurement) throw new TypeError('Specify --format asc|ply, --metadata and --measurement')
      const metadata = validateSurfaceMetadata(parseDocument(await readMissionFile(options.metadata)))
      const measurement = parseDocument(await readMissionFile(options.measurement))
      if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement) || Object.keys(measurement).length !== 5 || Object.keys(measurement).some(key => !['version', 'id', 'boundary', 'base', 'reference'].includes(key))) throw new TypeError('Measurement must declare exactly version, id, boundary, base and reference')
      const text = await readMissionFile(path, { preserveBom: true })
      const surface = options.format === 'asc' ? await importGridSurface(text, metadata) : await importPlySurface(text, metadata)
      const request = validateVolumeRequest({ ...measurement, surface })
      const { integrationPieces, ...report } = processStockpile(request)
      const dataset = options.output ? await writeVolumeDataset(options.output, request) : null
      print(JSON.stringify({ report, contributionCount: integrationPieces.length, dataset }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
