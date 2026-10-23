import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { createVtolTransitionProfile } from '../../resources/functions/drone/vehicles/vtol/transition-profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'

export default defineCommand({
  name: 'vtol:simulate',
  description: 'Exercise the fictional owned front/cruise/back/landing route; no physical control',
  options: {
    '--seconds <n>': { description: 'Maximum virtual duration, 2..180 seconds', default: '160' },
    '--electrical': { description: 'Use fictional electrical load and delayed battery measurements', default: false },
  },
  handle(options) {
    try {
      const result = runVehicleSimulation(createVtolTransitionProfile({ electrical: options.electrical }), { seconds: Number(options.seconds) })
      const { trace, path, ...report } = result
      const transitionEvidence = trace.rows.flatMap(row => row.observation.transition?.outcome === 'confirmed' ? [row.observation.transition] : [])
      const completeTransitions = transitionEvidence.length === 3 && transitionEvidence.every((row, index) => row.taskId === ['initial-hover', 'front', 'back'][index] && row.phase === ['hover', 'cruise', 'hover'][index])
      const observedFlight = path.some(row => row.positionM && row.positionM[2] < -1 && row.actuators.slice(0, 4).some(n => n > 0))
      const landingContact = path.at(-1)?.measurement?.values.onSurface === true
      const boardNeutral = result.board.actuators.every(n => n === 0) && result.board.expiresAtMs === null
      const demonstrationMatched = result.status === 'completed' && result.fault === null && result.mission.taskId === 'land' && result.mission.reason === 'landed' && completeTransitions && observedFlight && landingContact && boardNeutral
      print(JSON.stringify({ ...report, scope: 'development-lift-and-cruise', transitionEvidence, completeTransitions, observedFlight, landingContact, boardNeutral, demonstrationMatched, recordedMissionRows: trace.rows.length, evaluatedPathRows: path.length }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      if (!demonstrationMatched) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
