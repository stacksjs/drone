import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { inspectRuntimeCapture, maxRuntimeCaptureBytes } from '../../resources/functions/drone/runtime/capture'

export default defineCommand({
  name: 'runtime:inspect <capture>',
  description: 'Decode a bounded, receive-only raw UART capture without granting live authority',
  // eslint-disable-next-line
  async handle(options, capture) {
    try {
      const bytes = new Uint8Array(await Bun.file(capture).slice(0, maxRuntimeCaptureBytes + 1).arrayBuffer())
      // eslint-disable-next-line
      print(JSON.stringify(inspectRuntimeCapture(bytes), (key, value) => typeof value === 'bigint' ? value.toString() : value, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
