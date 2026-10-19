import type { ApplicationConfig, ApplicationPlantSnapshot, ApplicationScenario } from './types'
import type { ApplicationPlant, ApplicationPlantOptions } from './runtime-types'
import { createGroundPlant } from '../vehicles/ground/plant'
import { applicationPulseFactor, applicationScaleFactor } from './calibration'

/** Ground dynamics retain exactly four traction channels. Three independent normalized implement channels follow them. */
export function createApplicationPlant(config: ApplicationConfig, options: ApplicationPlantOptions = {}): ApplicationPlant {
  const ground = options.ground ?? createGroundPlant(), scale = applicationScaleFactor(config.calibration.scale)
  const pulseFactor = config.calibration.pulse ? applicationPulseFactor(config.calibration.pulse) : 0
  const initial = options.initialAmount ?? config.material.initialAmount
  if (!Number.isFinite(initial) || initial < 0 || initial > config.material.initialAmount) throw new RangeError('Invalid modeled application inventory')
  let atMs = options.startAtMs ?? 0, primary = 0, master = 0, energy = 0, remaining = initial, emitted = 0, loss = 0, flow = 0, release = 0
  let fault: ApplicationScenario | null = null, stuckPrimary = 0, stuckMaster = 0
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new RangeError('Invalid modeled application clock')
  const mass = () => config.material.unit === 'L' ? remaining * config.material.densityKgPerL! : remaining
  function meterSnapshot(): ApplicationPlantSnapshot { return { atMs, primaryPosition: primary, masterPosition: master, energy, flowPerSecond: flow, remainingAmount: remaining, emittedAmount: emitted, unmeteredLossAmount: loss, pulseCount: Math.floor(emitted * pulseFactor), scaleRaw: Math.round(config.calibration.scale.tareRaw + mass() * scale) } }
  function snapshot() {
    const state = ground.snapshot(), m = meterSnapshot()
    return { ...state, details: { ...state.details, applicationPrimary: primary, applicationMaster: master, applicationEnergy: energy, applicationFlow: flow, applicationRemaining: remaining, applicationEmitted: emitted, applicationPulseCount: m.pulseCount, applicationScaleRaw: m.scaleRaw } }
  }
  const slew = (value: number, goal: number, ms: number, dt: number) => value + Math.sign(goal - value) * Math.min(Math.abs(goal - value), dt * 1000 / ms)
  return {
    snapshot,
    meterSnapshot,
    setFault(next) {
      if (next === fault) return
      fault = next
      if (next === 'empty') { loss += remaining; remaining = 0 }
      if (next === 'stuck-valve' || next === 'master-stuck') stuckPrimary = Math.max(primary, .35)
      if (next === 'master-stuck') stuckMaster = Math.max(master, 1)
    },
    takeRelease() { const amount = release; release = 0; return amount },
    step(channels, dt, environment) {
      if (!Array.isArray(channels) || channels.length !== 7 || channels.some(n => !Number.isFinite(n)) || channels.slice(4).some(n => n < 0 || n > 1) || !Number.isFinite(dt) || dt <= 0 || dt > .01) throw new RangeError('Invalid seven-channel application plant input')
      ground.step(channels.slice(0, 4), dt, environment)
      primary = fault === 'stuck-valve' || fault === 'master-stuck' ? stuckPrimary : slew(primary, channels[4]!, config.calibration.primaryCloseMs, dt)
      master = fault === 'master-stuck' ? stuckMaster : slew(master, channels[5]!, config.calibration.masterCloseMs, dt)
      energy += (channels[6]! - energy) * (1 - Math.exp(-dt * 1000 / config.calibration.energyTauMs))
      // An explicitly modeled gravity/leak path survives energy cutoff if both mechanical barriers stick.
      const demand = fault === 'blocked-flow' ? 0 : config.calibration.maxRatePerSecond * primary * master * (.15 + .85 * energy)
      const amount = Math.min(remaining, demand * dt)
      flow = amount / dt; remaining -= amount; emitted += amount; release += amount; atMs += Math.round(dt * 1000)
      return snapshot()
    },
  }
}
