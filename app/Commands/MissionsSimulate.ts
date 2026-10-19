import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { MissionScenario } from '../../resources/functions/drone/missions/simulation'
import { missionScenarios, simulateMission } from '../../resources/functions/drone/missions/simulation'
import { parseMissionPlan } from '../../resources/functions/drone/missions/plan'
import { readMissionFile, writeMissionTrace } from '../../resources/functions/drone/missions/files'
import { createAirProfile } from '../../resources/functions/drone/vehicles/air'
import { createGroundProfile } from '../../resources/functions/drone/vehicles/ground'
import { createSurfaceProfile } from '../../resources/functions/drone/vehicles/surface'
import type { SurfaceScenario } from '../../resources/functions/drone/vehicles/surface'
import { createSubseaProfile } from '../../resources/functions/drone/vehicles/subsea'
import type { SubseaScenario } from '../../resources/functions/drone/vehicles/subsea'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
export default defineCommand({
  name: 'missions:simulate',
  description: 'Run an owned mission through modeled sensors, estimation, authority and profile controls',
  options: {
    '--profile <name>': { description: 'quadcopter, fixed-wing, ground, surface, subsea', default: 'quadcopter' },
    '--scenario <name>': { description: `Profile-specific scenario; quadcopter: ${missionScenarios.join(', ')}`, default: 'nominal' },
    '--seconds <n>': { description: 'Maximum virtual duration, quadcopter 8..120 (default 45), other profiles 2..180 (default 120)' },
    '--plan <path>': { description: 'Optional v1 mission JSON plan' },
    '--output <directory>': { description: 'New private directory for the replayable mission trace' },
  },
  async handle(options) {
    try {
      if (!['quadcopter', 'fixed-wing', 'ground', 'surface', 'subsea'].includes(options.profile)) throw new RangeError('Unknown mission simulation profile')
      const seconds = Number(options.seconds ?? (options.profile === 'quadcopter' ? '45' : '120'))
      if (options.profile !== 'quadcopter') {
        if (options.plan) throw new TypeError('--plan is supported only by the quadcopter v1 simulation')
        const profile = options.profile === 'fixed-wing' ? createAirProfile(options.scenario) : options.profile === 'ground' ? createGroundProfile(options.scenario) : options.profile === 'surface' ? createSurfaceProfile(options.scenario as SurfaceScenario) : createSubseaProfile(options.scenario as SubseaScenario)
        const { trace, path, ...result } = runVehicleSimulation(profile, { scenario: options.scenario, seconds })
        const tracePath = options.output ? await writeMissionTrace(options.output, trace) : null
        print(JSON.stringify({ ...result, recordedMissionRows: trace.rows.length, evaluatedPathRows: path.length, tracePath }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
        const expected = ['nominal', 'crosswind', 'logistics', 'current', 'harbour-return'].includes(options.scenario) ? 'completed' : options.scenario === 'host-loss' ? 'host-lost' : 'blocked'
        if (result.status !== expected) process.exitCode = 1
        return
      }
      const plan = options.plan ? parseMissionPlan(await readMissionFile(options.plan)).plan : undefined
      const { trace, ...result } = simulateMission({ scenario: options.scenario as MissionScenario, seconds, plan })
      const tracePath = options.output ? await writeMissionTrace(options.output, trace) : null
      // eslint-disable-next-line
      print(JSON.stringify({ ...result, tracePath }, (key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      const expected = options.scenario === 'abort' ? 'aborted' : ['rc-override', 'reserve'].includes(options.scenario) ? 'blocked' : 'completed'
      if (result.mission.state !== expected) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
