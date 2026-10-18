import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { NavigationScenario } from '../../resources/functions/drone/navigation/simulation'
import { navigationScenarios, simulateNavigation } from '../../resources/functions/drone/navigation/simulation'
export default defineCommand({
  name: 'navigation:simulate',
  description: 'Exercise range-backed avoidance, terrain clearance, RTL and selected-site landing on the owned physics stack',
  options: {
    '--scenario <name>': { description: navigationScenarios.join(', '), default: 'avoid-land' },
    '--seconds <n>': { description: 'Maximum virtual duration, 8..120 seconds', default: '70' },
  },
  handle(options) {
    try {
      // Detailed sensor-derived decisions remain available through the function interface.
      const { trace, navTrace, path, ...result } = simulateNavigation({ scenario: options.scenario as NavigationScenario, seconds: Number(options.seconds) })
      // eslint-disable-next-line
      print(JSON.stringify({ ...result, recordedMissionRows: trace.rows.length, recordedNavigationRows: navTrace.length, evaluatedPathRows: path.length }, (key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      const expected = ['avoid-land', 'replan'].includes(options.scenario) ? 'completed' : 'blocked'
      if (result.mission.state !== expected) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
