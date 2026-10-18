import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { buildRuntime } from '../../resources/functions/drone/runtime/build'

export default defineCommand({
  name: 'runtime:build',
  description: 'Build the owned neutral-only kernel for the host or Pico 2 bench board',
  options: {
    '--target <target>': { description: 'host or pico2', default: 'host' },
    '--project <path>': 'Drone source checkout, defaults to the current directory',
    '--sdk <path>': 'Clean Pico SDK checkout at the recorded commit',
    '--toolchain <path>': 'Arm GNU toolchain root for Pico 2 cross-compilation',
    '--watchdog-test': { description: 'Build a separate Pico image that deliberately hangs after two seconds', default: false },
    '--sensors': { description: 'Build the separate ICM42688P/BMP280/NAV-PVT neutral-only acquisition image', default: false },
  },
  async handle(options) {
    try {
      if (options.target !== 'host' && options.target !== 'pico2') throw new Error('Target must be host or pico2')
      print(JSON.stringify(await buildRuntime({ target: options.target, project: options.project, sdk: options.sdk, toolchain: options.toolchain, watchdogTest: options.watchdogTest, sensors: options.sensors }), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
