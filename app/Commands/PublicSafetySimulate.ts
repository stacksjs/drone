import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import type { IncidentPurpose } from '../../resources/functions/drone/public-safety/types'
import type { PublicSafetyScenario } from '../../resources/functions/drone/public-safety/runtime-types'
import { publicSafetyScenarios } from '../../resources/functions/drone/public-safety/runtime-types'
import { examplePublicSafetyConfig } from '../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../resources/functions/drone/public-safety/runtime'
import { writePublicSafetyDataset } from '../../resources/functions/drone/public-safety/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'public-safety:simulate',
  description: 'Collect synthetic visible/numeric thermal evidence through the actual owned incident mission loop',
  options: {
    '--config <path>': 'Explicit incident configuration instead of a synthetic purpose fixture',
    '--purpose <name>': 'search-and-rescue, fire-observation, disaster-assessment or lawful-police-observation',
    '--scenario <name>': { description: publicSafetyScenarios.join(', '), default: 'nominal' },
    '--seconds <n>': { description: 'Maximum virtual duration, 8..120 integer seconds', default: '100' },
    '--output <directory>': 'New private source/PNG/numeric thermal dataset; access and retention are not enforced by offline files',
  },
  async handle(options) {
    try {
      if (!/^\d+$/.test(options.seconds) || (options.config && options.purpose)) throw new RangeError('Choose a config or purpose and integer duration 8..120')
      let config: unknown
      if (options.config) {
        try { config = JSON.parse(await readMissionFile(options.config, { maxBytes: 256 * 1024 })) }
        catch { throw new TypeError('Invalid public-safety configuration JSON or file') }
      }
      else config = examplePublicSafetyConfig(options.purpose as IncidentPurpose | undefined)
      const run = simulatePublicSafety({ config, scenario: options.scenario as PublicSafetyScenario, seconds: Number(options.seconds) })
      const dataset = options.output ? await writePublicSafetyDataset(options.output, run) : null
      await printAsync(JSON.stringify({ evidence: run.evidence, incidentId: run.plan.config.id, purpose: run.plan.config.purpose, status: run.survey.status, reason: run.survey.reason, sessionId: run.sessionId, captures: run.captures.length, lastEpoch: run.epochs.at(-1), faultDemonstrated: run.faultDemonstrated, boardNeutral: run.survey.boardNeutral, physicalFlightEnabled: false, identityAuthenticated: false, dataset }, null, 2))
      if (!run.survey.boardNeutral || (run.scenario === 'nominal' ? run.survey.status !== 'completed' : !run.faultDemonstrated)) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
