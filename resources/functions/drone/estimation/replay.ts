import { createSensorReplay } from '../sensors/replay'
import { createEstimator } from './estimator'
import type { GeodeticOrigin } from './frames'
/** Every sensor event reaches the estimator, independently of caller playback step size. */
export function createEstimatorReplay(input: unknown, options: { origin?: GeodeticOrigin } = {}) {
  const estimator = createEstimator(options)
  const sensors = createSensorReplay(input, { onUpdate: frame => { estimator.update(frame) } })
  function snapshot() { return { sensors: sensors.snapshot(), estimate: estimator.snapshot(sensors.snapshot().nowMs) } }
  return {
    snapshot,
    advanceTo(nowMs: number) { sensors.advanceTo(nowMs); return snapshot() },
  }
}
export type EstimatorReplay = ReturnType<typeof createEstimatorReplay>
