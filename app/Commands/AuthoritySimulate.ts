import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { AuthorityScenario } from '../../resources/functions/drone/authority/harness'
import { authorityScenarios } from '../../resources/functions/drone/authority/harness'
import { simulateMultirotor } from '../../resources/functions/drone/controls/simulation'
export default defineCommand({
  name: 'authority:simulate',
  description: 'Exercise versioned authority, fault revocation and an independent modeled output watchdog',
  options: {
    '--scenario <name>': { description: authorityScenarios.join(', '), default: 'nominal' },
    '--seconds <n>': { description: 'Integer virtual duration, 4..60 seconds', default: '8' },
  },
  handle(options) {
    try {
      const seconds = Number(options.seconds)
      if (!authorityScenarios.includes(options.scenario as AuthorityScenario) || !Number.isInteger(seconds) || seconds < 4 || seconds > 60) throw new RangeError('Unknown authority scenario or invalid duration (4..60 s)')
      const result = simulateMultirotor({ authorityScenario: options.scenario as AuthorityScenario, seconds })
      // eslint-disable-next-line
      print(JSON.stringify(result, (key, value) => typeof value === 'bigint' ? String(value) : value, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
