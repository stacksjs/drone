import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { runPayloadBench, payloadJson } from '../../resources/functions/drone/payloads/bench'
import { openPiAiCameraPayload } from '../../resources/functions/drone/payloads/pi-camera'
import { createPayloadCaptureSession } from '../../resources/functions/drone/payloads/capture'
import { createPayloadPoseTimeline } from '../../resources/functions/drone/payloads/pose'
import { savePayloadCapture } from '../../resources/functions/drone/payloads/artifact'
export default defineCommand({
  name: 'payloads:capture',
  description: 'Save one acknowledged camera image and manifest to a new local directory',
  options: {
    '--driver <name>': { description: 'replay or imx500 (explicit physical camera acquisition)', default: 'replay' },
    '--output <directory>': { description: 'Required new directory; parent must exist' },
    '--project <path>': { description: 'Project containing the Pi camera worker (required outside checkout)' },
  },
  async handle(options) {
    try {
      if (!options.output || !['replay', 'imx500'].includes(options.driver)) throw new TypeError('Supply --output and a replay or imx500 driver')
      if (options.driver === 'replay') {
        const result = await runPayloadBench()
        if (!result.capture) throw new Error('Replay capture unavailable')
        print(payloadJson(await savePayloadCapture(result.capture, options.output)))
      }
      else {
        const adapter = await openPiAiCameraPayload({ project: options.project })
        // This standalone acquisition command has no live owned sensor connection. Never invent a vehicle pose.
        const session = createPayloadCaptureSession({ adapter, poses: createPayloadPoseTimeline() })
        try { print(payloadJson(await savePayloadCapture(await session.capture(), options.output))) }
        finally { session.close() }
      }
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
