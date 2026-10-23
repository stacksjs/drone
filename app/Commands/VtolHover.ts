import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { createVtolHoverProfile, vtolHoverScenarios } from '../../resources/functions/drone/vehicles/vtol'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'

export default defineCommand({
  name: 'vtol:hover',
  description: 'Exercise the fictional lift-and-cruise airframe in hover only; no wing transition or physical control',
  options: {
    '--scenario <name>': { description: vtolHoverScenarios.join(', '), default: 'hover' },
    '--seconds <n>': { description: 'Maximum virtual duration, 2..180 seconds', default: '60' },
    '--electrical': { description: 'Use modeled electrical load, battery loss and delayed energy measurements', default: false },
  },
  handle(options) {
    try {
      const result = runVehicleSimulation(createVtolHoverProfile(options.scenario, { electrical: options.electrical }), { scenario: options.scenario, seconds: Number(options.seconds) })
      const { trace, path, ...report } = result
      const expectedStatus = options.scenario === 'hover' ? 'completed' : options.scenario === 'host-loss' ? 'host-lost' : 'blocked'
      const observedFlight = path.some(row => row.truthPositionM[2] < -1 && row.actuators.slice(0, 4).some(n => n > 0))
      const boardNeutral = result.board.actuators.every(n => n === 0) && result.board.expiresAtMs === null
      const hoverOnly = path.every(row => row.actuators.slice(4).every(n => n === 0))
      const demonstrationMatched = result.status === expectedStatus && observedFlight && boardNeutral && hoverOnly
      print(JSON.stringify({ ...report, scope: 'development-hover-only', transitionsImplemented: false, expectedStatus, demonstrationMatched, observedFlight, boardNeutral, hoverOnly, recordedMissionRows: trace.rows.length, evaluatedPathRows: path.length }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      if (!demonstrationMatched) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
