import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { antennaBenchScenarios, runAntennaBench } from '../../resources/functions/drone/antenna/bench'
import type { AntennaBenchScenario } from '../../resources/functions/drone/antenna/bench'

function validateNumber(value: string): number {
  if (!/^\d+$/.test(value)) throw new RangeError('Antenna bench seconds must be an integer from 10 to 60')
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 10 || number > 60) throw new RangeError('Antenna bench seconds must be an integer from 10 to 60')
  return number
}

export default defineCommand({
  name: 'antenna:bench',
  aliases: ['antenna:simulate'],
  description: 'Simulate selected-vehicle antenna tracking and modeled pointing/link evidence',
  options: {
    '--scenario <name>': { description: antennaBenchScenarios.join(', '), default: 'nominal' },
    '--seconds <n>': { description: 'Integer virtual duration, 10..60 seconds', default: '12' },
  },
  handle(options) {
    try { print(JSON.stringify(runAntennaBench({ scenario: options.scenario as AntennaBenchScenario, seconds: validateNumber(options.seconds) }), null, 2)) }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
