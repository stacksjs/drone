import { simulateVision, visionScenarios } from '../resources/functions/drone/vision/simulation'

const evidence = {
  kind: 'owned-vision-physics-simulation',
  physicalFlightEnabled: false,
  physicalCalibrationVerified: false,
  headingAlignment: 'initial-simulation-north',
  depthSource: 'synthetic-registered-optical-z',
  scenarios: visionScenarios.map(scenario => {
    const result = simulateVision({ scenario })
    return { scenario, status: result.status, fusion: result.fusion.state, reason: result.fusion.reason, calibration: result.calibration, ...result.metrics, boardNeutral: result.board.motorsN.every(n => n === 0) }
  }),
}
await Bun.write(new URL('../docs/vision-evidence.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`)
