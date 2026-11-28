import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { parseJsonText } from '@stacksjs/router/json'
import { printAsync } from '../../resources/functions/cli/output'
import type { ApplicationImplement, ApplicationScenario } from '../../resources/functions/drone/application/types'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'
import { applicationScenarios, simulateAerialApplication, simulateApplication } from '../../resources/functions/drone/application/runtime'
import { processApplication } from '../../resources/functions/drone/application/coverage'
import { applicationAircraftSummary } from '../../resources/functions/drone/application/aerial'
import { writeApplicationDataset } from '../../resources/functions/drone/application/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'application:simulate',
  description: 'Run owned inert sprayer or spreader physics with independent implement authority and metering',
  options: {
    '--config <path>': 'Optional explicit application JSON instead of a preset',
    '--vehicle <name>': { description: 'ground or quadcopter; quadcopter requires an aerial water configuration', default: 'ground' },
    '--implement <name>': 'Preset: sprayer or spreader, defaults to sprayer',
    '--scenario <name>': { description: applicationScenarios.join(', '), default: 'nominal' },
    '--mode <name>': { description: 'test or apply; apply also requires explicit implement authorization', default: 'test' },
    '--authorize-implement': { description: 'Grant the separate modeled implement lease', default: false },
    '--visit <id>': { description: 'Explicit recording identity', default: 'application-visit-1' },
    '--seconds <n>': { description: 'Virtual duration, 2..180 integer seconds', default: '120' },
    '--output <directory>': 'New private recording, coverage, calibration and material dataset',
  },
  async handle(options) {
    try {
      if (!['test', 'apply'].includes(options.mode) || !/^\d+$/.test(options.seconds)) throw new RangeError('Application requires mode test/apply and integer seconds 2..180')
      if (!['ground', 'quadcopter'].includes(options.vehicle)) throw new RangeError('Application vehicle must be ground or quadcopter')
      if (options.config && options.implement) throw new TypeError('Choose an explicit configuration or an implement preset')
      if (options.vehicle === 'quadcopter' && !options.config) throw new TypeError('Quadcopter simulation requires an explicit aerial water configuration')
      let config: unknown
      if (options.config) {
        const text = await readMissionFile(options.config, { maxBytes: 256 * 1024 })
        try { config = parseJsonText(text, { rejectDuplicateKeys: true }) }
        catch { throw new TypeError('Invalid application configuration JSON') }
      }
      else config = exampleApplicationConfig((options.implement ?? 'sprayer') as ApplicationImplement)
      const request = { scenario: options.scenario as ApplicationScenario, visitId: options.visit, seconds: Number(options.seconds), authorizeImplement: options.authorizeImplement, testMode: options.mode === 'test' }
      const aerial = options.vehicle === 'quadcopter' ? simulateAerialApplication(config, request) : null
      const run = aerial ?? simulateApplication({ ...request, config })
      const report = processApplication(run)
      const dataset = options.output ? await writeApplicationDataset(options.output, run) : null
      const aircraft = applicationAircraftSummary(run)
      await printAsync(JSON.stringify({ status: run.status, reason: run.reason, visitId: run.options.visitId, implement: run.config.implement.type, unit: report.unit, emittedAmount: report.emittedAmount, inFieldAmount: report.inFieldAmount, excludedAmount: report.excludedAmount, outsideAmount: report.outsideAmount, inFlightAmount: report.inFlightAmount, coveredAreaM2: report.coveredAreaM2, missedAreaM2: report.missedAreaM2, overlapAreaM2: report.overlapAreaM2, shutdown: run.shutdown, faultDemonstrated: run.faultDemonstrated, ...(aircraft ? { aircraft } : {}), physicalTrialEligible: false, physicalApplicationVerified: false, dataset }, null, 2))
      const expected = options.scenario === 'nominal' ? run.status === (run.options.testMode || !run.options.authorizeImplement ? 'dry-completed' : 'completed') : run.faultDemonstrated && ['blocked', 'host-lost'].includes(run.status)
      if (!expected) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
