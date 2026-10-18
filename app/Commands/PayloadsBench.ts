import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { PayloadScenario } from '../../resources/functions/drone/payloads/bench'
import { payloadJson, runPayloadBench } from '../../resources/functions/drone/payloads/bench'
export default defineCommand({
  name: 'payloads:bench',
  description: 'Exercise camera ACKs and owned-estimator pose association without hardware',
  options: { '--scenario <name>': { description: 'nominal, wrong-identity, stale-clock, lost-ack or pose-reset', default: 'nominal' } },
  async handle(options) {
    try { print(payloadJson(await runPayloadBench(options.scenario as PayloadScenario))) }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
