import { simulateMultirotor, controlScenarios } from '../../../resources/functions/drone/controls/simulation'
const scenarios = controlScenarios.map(scenario => {
  const result = simulateMultirotor({ scenario, seconds: 20 })
  return { scenario, seconds: result.seconds, additionalSensorDelayMs: result.additionalSensorDelayMs, response: result.response, metrics: result.metrics, finalPositionM: result.state.positionM, finalReason: result.control?.reason }
})
console.log(JSON.stringify({ evidence: 'owned-rigid-body-simulation-only', hardwareValidated: false, physicalFlightEnabled: false, boardOutputsInhibited: true, assumptions: ['invented fixed vehicle parameters', 'declared initial north alignment', 'stationary supported startup for 600 ms', 'gravity correction at initialization only, then gyro propagation', 'deterministic dither and quantization, no measured noise or bias', '250 Hz semi-implicit rigid body and 50 Hz controller/IMU, 10 Hz GNSS', '4 ms base sensor delivery plus configured delay, no UART serialization', 'zero commands on faults are not a landing controller'], scenarios }, null, 2))
