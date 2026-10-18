import { clampControl } from './model'
export interface PidGains { kp: number, ki: number, kd: number, integralLimit: number, outputLimit: number, derivativeTauS: number, trackingGain: number }
/** Derivative on measurement, conditional integral and bounded allocation tracking feedback. */
export function createBoundedPid(input: PidGains) {
  const g = { ...input }
  if (!Object.values(g).every(n => Number.isFinite(n) && n >= 0) || g.outputLimit <= 0 || g.derivativeTauS <= 0) throw new RangeError('Invalid simulated PID gains')
  let integral = 0, derivative = 0, previous: number | null = null
  return {
    reset() { integral = 0; derivative = 0; previous = null },
    state() { return { integral, derivative } },
    step(error: number, measurement: number, dtS: number) {
      if (![error, measurement, dtS].every(Number.isFinite) || dtS <= 0 || dtS > 0.1) throw new RangeError('Invalid PID input or interval')
      const measuredDerivative = previous === null ? 0 : (measurement - previous) / dtS
      derivative += dtS / (g.derivativeTauS + dtS) * (measuredDerivative - derivative); previous = measurement
      const candidate = clampControl(integral + g.ki * error * dtS, g.integralLimit)
      const raw = g.kp * error + candidate - g.kd * derivative
      if (error * (raw - clampControl(raw, g.outputLimit)) <= 0) integral = candidate
      return clampControl(g.kp * error + integral - g.kd * derivative, g.outputLimit)
    },
    track(residual: number, dtS: number) {
      if (![residual, dtS].every(Number.isFinite) || dtS <= 0 || dtS > 0.1) throw new RangeError('Invalid allocation tracking feedback')
      if (g.ki > 0) integral = clampControl(integral + g.trackingGain * residual * dtS, g.integralLimit)
    },
  }
}
