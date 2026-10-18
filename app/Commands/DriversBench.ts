import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { AutopilotDriverId } from '../../resources/functions/drone/drivers/profiles'
import { runDriverProtocolBench } from '../../resources/functions/drone/drivers/bench'
export default defineCommand({
  name: 'drivers:bench',
  description: 'Exercise acknowledged commands, parameters and missions against a scripted local protocol peer',
  options: {
    '--driver <name>': { description: 'ardupilot or px4', default: 'ardupilot' },
    '--drop-first-ack': 'Deliberately drop the first message-rate ACK to exercise retry',
    '--signed': 'Use a public fixture key to test required MAVLink 2 signatures',
  },
  async handle(options) {
    try {
      const result = await runDriverProtocolBench({ driver: options.driver as AutopilotDriverId, signed: options.signed, dropFirstAck: options.dropFirstAck })
      // eslint-disable-next-line
      print(JSON.stringify(result, (key, value) => typeof value === 'bigint' ? String(value) : value, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
