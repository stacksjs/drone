import type { SensorVector } from '../sensors/types'
import type { AxisState } from './position'
import { predictAxis } from './position'

export const fixtureInertialModel = Object.freeze({ mode: 'fixture-imu' as const, version: 'fixture-imu-v1' as const, accelerationErrorCorrelation: 'held-between-gnss-fixes' as const, attitudeErrorRad: 0.03, maximumImuGapMs: 50, maximumImuAgeMs: 80, maximumGnssAgeMs: 1500, historySamples: 128, maximumTimeUncertaintyUs: 1000, fixedEpochMapping: true as const, initialNorthHeadingAssumed: true as const, physicalFlightEnabled: false as const })

/** Bounded fixture prediction, with no physical heading or measured noise qualification. */
export function createFixtureInertialPrediction() {
  const history: { atMs: number, acceleration: SensorVector, variance: SensorVector }[] = []
  return {
    reset() { history.length = 0 },
    record(atMs: number, acceleration: SensorVector, variance: SensorVector) {
      if (history.length && atMs <= history.at(-1)!.atMs) { history.length = 0; return }
      history.push({ atMs, acceleration: [...acceleration], variance: [...variance] })
      if (history.length > fixtureInertialModel.historySamples) history.shift()
    },
    predict(axes: AxisState[], fromMs: number, toMs: number): AxisState[] | null {
      if (toMs < fromMs || toMs - fromMs > fixtureInertialModel.maximumGnssAgeMs) return null
      let sample = history.findLast(row => row.atMs <= fromMs)
      if (!sample || fromMs - sample.atMs > fixtureInertialModel.maximumImuGapMs) return null
      let result = axes.map(axis => ({ ...axis })), atMs = fromMs
      let maximumVariance: SensorVector = [...sample.variance]
      for (const next of history.filter(row => row.atMs > fromMs && row.atMs <= toMs)) {
        if (next.atMs - sample.atMs > fixtureInertialModel.maximumImuGapMs) return null
        const dt = (next.atMs - atMs) / 1000
        result = result.map((axis, i) => predictAxis(axis, dt, sample!.acceleration[i]!, 0))
        maximumVariance = maximumVariance.map((n, i) => Math.max(n, next.variance[i]!)) as SensorVector
        atMs = next.atMs; sample = next
      }
      if (toMs - sample.atMs > fixtureInertialModel.maximumImuAgeMs) return null
      const dt = (toMs - atMs) / 1000
      result = result.map((axis, i) => predictAxis(axis, dt, sample!.acceleration[i]!, 0))
      // A held acceleration/attitude error is correlated across this prediction.
      // Adding independent per-sample Q would understate uncertainty as rate rises.
      const totalDt = (toMs - fromMs) / 1000
      return result.map((axis, i) => {
        const error = predictAxis({ p: 0, v: 0, pp: 0, pv: 0, vv: 0 }, totalDt, 0, maximumVariance[i]!)
        return { ...axis, pp: axis.pp + error.pp, pv: axis.pv + error.pv, vv: axis.vv + error.vv }
      })
    },
  }
}
