import { expect, test } from 'bun:test'
import type { SimulatedControlInput } from '../../resources/functions/drone/controls/controller'
import { createEstimatorReplay } from '../../resources/functions/drone/estimation/replay'
import { createVtolHoverController } from '../../resources/functions/drone/vehicles/vtol/hover-controller'
import type { ImuMeasurement, SensorVector } from '../../resources/functions/drone/sensors/types'
import { createVtolPlant } from '../../resources/functions/drone/vehicles/vtol/plant'
import { createPhysicsSensorFeed } from '../../resources/functions/drone/controls/sensors'
import { createEstimator } from '../../resources/functions/drone/estimation/estimator'
import motion from '../fixtures/estimation/motion-v1.json'

function hoverInput(nowMs = 1000): SimulatedControlInput {
  const estimate = createEstimatorReplay(motion).advanceTo(1040).estimate
  estimate.nowMs = nowMs
  estimate.attitude!.quaternionWxyz = [1, 0, 0, 0]
  estimate.attitude!.capturedAtMs = nowMs
  estimate.localPosition!.positionM = [0, 0, -10]
  estimate.localPosition!.velocityMps = [0, 0, 0]
  estimate.localPosition!.capturedAtMs = nowMs
  estimate.localPosition!.predictedToMs = nowMs
  return { kind: 'simulation', enabled: true, nowMs, estimate, angularRateRadS: [0, 0, 0], rateCapturedAtMs: nowMs, target: { positionM: [0, 0, -10], yawRad: 0, issuedAtMs: nowMs } }
}

// Public estimator-to-control seam catches model mass and allocation, not closed-loop flight or transition qualification.
test('owned VTOL hover feedback requests the 2.5 kg weight using its own rotor order and limits', () => {
  const output = createVtolHoverController({ headingAlignment: 'initial-simulation-north' }).step(hoverInput())
  expect(output.inhibited).toBe(false)
  expect(output.desiredWrench!.thrustN).toBeCloseTo(24.516625, 10)
  expect(output.desiredWrench!.torqueNm).toEqual([0, 0, 0])
  for (const thrustN of output.motorsN) expect(thrustN).toBeCloseTo(6.12915625, 10)
  expect(output.physicalFlightEnabled).toBe(false)
  expect(output.boardOutputsInhibited).toBe(true)
})

// Public owned sensor/estimator/control/plant seams catch closed-loop response, not mission, authority or transition qualification.
test('the VTOL body follows a hover position step using raw IMU and GNSS rather than plant pose feedback', () => {
  const plant = createVtolPlant(), feed = createPhysicsSensorFeed(0)
  const estimator = createEstimator({ origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, gravityCorrection: 'initialization-only' })
  const controller = createVtolHoverController({ headingAlignment: 'initial-simulation-north' })
  let state = plant.snapshot(), command = [0, 0, 0, 0], activeTicks = 0, inhibitedTicks = 0, invalidCommands = 0, maxTiltRad = 0
  let estimate = estimator.snapshot(0)
  const targetAt = (nowMs: number): SensorVector => nowMs >= 2000 ? [2, 1, -1.5] : [0, 0, -1]
  for (let nowMs = 0; nowMs <= 20000; nowMs += 4) {
    if (nowMs > 600) state = plant.step([...command, 0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
    feed.capture(state, nowMs)
    const sensors = feed.advanceTo(nowMs)
    estimate = estimator.update(sensors)
    if (nowMs >= 600 && nowMs % 20 === 0) {
      const observation = sensors.sensors.find(s => s.kind === 'imu')?.observation
      const imu = observation?.value as ImuMeasurement | undefined
      const output = controller.step({ kind: 'simulation', enabled: true, nowMs, estimate, angularRateRadS: imu?.angularRateRadS ?? [0, 0, 0], rateCapturedAtMs: observation?.estimatedCaptureMs ?? -Infinity, target: { positionM: targetAt(nowMs), yawRad: 0, issuedAtMs: nowMs } })
      command = [...output.motorsN]
      if (output.inhibited) inhibitedTicks++
      else activeTicks++
      if (command.some(n => !Number.isFinite(n) || n < 0 || n > 12)) invalidCommands++
    }
    maxTiltRad = Math.max(maxTiltRad, Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (state.quaternionWxyz[1] ** 2 + state.quaternionWxyz[2] ** 2)))))
  }
  expect(activeTicks).toBe(971)
  expect(inhibitedTicks).toBe(0)
  expect(invalidCommands).toBe(0)
  expect(Math.hypot(...state.positionM.map((n, i) => n - targetAt(20000)[i]!))).toBeLessThan(0.2)
  expect(maxTiltRad).toBeLessThan(0.44)
  expect(state.onSurface).toBe(false)
  expect(estimate.health.localPosition).toBe(true)
  expect(estimate.health.absoluteHeading).toBe(false)
})
