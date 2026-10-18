import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { inspectSensorCapture } from '../../resources/functions/drone/sensors/capture'

export default defineCommand({
  name: 'sensors:inspect <capture>',
  description: 'Inspect a receive-only mixed DR/DS UART capture without granting sensor authority',
  // eslint-disable-next-line
  async handle(options, capture) {
    try {
      const bytes = new Uint8Array(await Bun.file(capture).slice(0, 1048577).arrayBuffer())
      // eslint-disable-next-line
      print(JSON.stringify(inspectSensorCapture(bytes), (key, value) => typeof value === 'bigint' ? value.toString() : value, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
