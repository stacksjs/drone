import type { ApplicationOptions, ApplicationScenario } from './types'
import type { ApplicationControllerInput, ApplicationDecision, ApplicationGrant, ApplicationMeterFeedback, ApplicationPlant, ApplicationProbe, ApplicationRun } from './runtime-types'
import type { VehicleProfile } from '../vehicles/types'
import { createGroundSession, createGroundProfile } from '../vehicles/ground/profile'
import { createGroundOdometry } from '../vehicles/ground/odometry'
import { runVehicleSimulation } from '../vehicles/runtime'
import { planApplication } from './planner'
import { exampleApplicationConfig } from './fixtures'
import { createApplicationController } from './controller'
import { createApplicationPlant } from './plant'

export const applicationScenarios = ['nominal', 'empty', 'stuck-valve', 'master-stuck', 'blocked-flow', 'meter-loss', 'meter-replay', 'weather', 'manual', 'host-loss', 'emergency', 'localization-loss', 'guard-open', 'lease-expiry'] as const
/** Actual ground dynamics and delayed quantized instruments; all releases and tail probes are independent modeled truth. */
export function simulateApplication(options: ApplicationOptions = {}): ApplicationRun {
  const scenario = options.scenario ?? 'nominal', visitId = options.visitId ?? 'application-visit-1', seconds = options.seconds ?? 120
  const authorizeImplement = options.authorizeImplement ?? false, testMode = options.testMode ?? true
  if (!applicationScenarios.includes(scenario) || !/^[a-z][a-z0-9-]{0,63}$/.test(visitId) || typeof authorizeImplement !== 'boolean' || typeof testMode !== 'boolean' || !Number.isSafeInteger(seconds) || seconds < 2 || seconds > 180) throw new RangeError('Invalid application options')
  const plan = planApplication(options.config ?? exampleApplicationConfig()), config = plan.config
  const inputs: ApplicationControllerInput[] = [], decisions: ApplicationDecision[] = [], probes: ApplicationProbe[] = [], releases: ApplicationRun['releases'] = []
  let plant: ApplicationPlant | null = null, faultAtMs: number | null = null, hostLossAtMs: number | null = null, faultInjected = false
  let lastTaskId: string | null = null, lastDecision: ApplicationDecision | null = null, shutdownAt: number | null = null
  let releaseAmount = 0, releaseHostAvailable = true, lastProbe: ApplicationProbe | null = null
  function activeFault(nowMs: number) { return faultAtMs !== null && nowMs >= faultAtMs && (scenario === 'master-stuck' || scenario === 'stuck-valve' || nowMs < faultAtMs + 2000) }
  function flushRelease(probe: ApplicationProbe) {
    if (releaseAmount > 0) releases.push({ atMs: probe.atMs, amount: releaseAmount, positionM: [...probe.positionM], yawRad: probe.yawRad, windMps: [...config.weather.windMps], taskId: releaseHostAvailable ? lastTaskId : null, hostAvailable: releaseHostAvailable, positionEvidence: 'modeled-plant-truth' })
    releaseAmount = 0; releaseHostAvailable = true
  }
  const groundProfile = createGroundProfile('nominal')
  const profile: VehicleProfile = {
    ...groundProfile, scenario, name: `Owned inert ${config.implement.type} application`, scenarios: applicationScenarios, mission: plan.mission,
    actuators: [...groundProfile.actuators, ...['primary-meter', 'independent-master-isolation', 'pump-or-auger-energy'].map(name => ({ name, unit: 'normalized' as const, min: 0, max: 1, neutral: 0 }))],
    createSession() {
      const base = createGroundSession(), baseController = base.createController(), odometry = createGroundOdometry()
      const controller = createApplicationController(config, { visitId, authorizeImplement, testMode })
      let meterSequence = 0, frozenMeterSequence: number | null = null, grantSequence = 0, lastGrantAt = -Infinity, granted = false
      plant = createApplicationPlant(config, { ground: base.createPlant(), startAtMs: 600 })
      return {
        createPlant: () => plant!,
        createController: () => ({ step(context) {
          const ground = odometry.step(context.measurement, context.estimate, context.nowMs), v = context.measurement?.values
          const fields = ['applicationMeterSequence', 'applicationMeterAtMs', 'applicationPulseCount', 'applicationScaleRaw', 'applicationPrimaryEncoder', 'applicationMasterEncoder', 'applicationEnergyEncoder']
          const feedback: ApplicationMeterFeedback | null = v && v.applicationCalibration === config.calibration.id && fields.every(key => typeof v[key] === 'number') ? { sequence: Number(v.applicationMeterSequence), capturedAtMs: Number(v.applicationMeterAtMs), pulseCount: Number(v.applicationPulseCount), scaleRaw: Number(v.applicationScaleRaw), primaryEncoder: Number(v.applicationPrimaryEncoder), masterEncoder: Number(v.applicationMasterEncoder), energyEncoder: Number(v.applicationEnergyEncoder) } : null
          const reference = context.measurement?.reference ?? `${context.estimate.bootId}:${Object.values(context.estimate.resets).join(',')}`
          let grant: ApplicationGrant | null = null
          if (authorizeImplement && !testMode && context.enabled && (!granted || context.nowMs - lastGrantAt >= 80) && !(scenario === 'lease-expiry' && faultAtMs !== null && context.nowMs >= faultAtMs)) {
            grant = { action: granted ? 'renew' : 'grant', sequence: ++grantSequence, issuedAtMs: context.nowMs, expiresAtMs: context.nowMs + 200, visitId, configId: config.id, materialId: config.material.id, reference }
            lastGrantAt = context.nowMs; granted = true
          }
          else if (granted && !context.enabled) { grant = { action: 'revoke', sequence: ++grantSequence, issuedAtMs: context.nowMs, expiresAtMs: context.nowMs, visitId, configId: config.id, materialId: config.material.id, reference }; granted = false }
          const weather = { ...config.weather, windMps: [...config.weather.windMps] as [number, number], capturedAtMs: context.nowMs }
          if (scenario === 'weather' && activeFault(context.nowMs)) weather.windMps = [config.weatherLimits.maxWindMps + 1, 0]
          const input: ApplicationControllerInput = { atMs: context.nowMs, enabled: context.enabled, reference, missionState: context.mission.state, taskId: context.mission.taskId, ground, feedback, weather, grant, emergency: scenario === 'emergency' && activeFault(context.nowMs) }
          const decision = controller.step(input), drive = baseController.step(context)
          if (decision.state === 'applying') shutdownAt = null
          else if (lastDecision?.state === 'applying') shutdownAt ??= context.nowMs
          lastTaskId = context.mission.taskId; lastDecision = decision
          inputs.push(structuredClone(input)); decisions.push(structuredClone(decision))
          return { ...drive, actuators: decision.stopVehicle ? [0, 0, 0, 1, 0, 0, 0] : [...drive.actuators, ...decision.channels], inhibited: drive.inhibited || decision.stopVehicle, reason: decision.stopVehicle ? decision.reason : drive.reason }
        } }),
        renderMeasurement(state, atMs, reference) {
          const packet = base.renderMeasurement(state, atMs, reference), count = config.calibration.encoderCounts
          const fault = activeFault(atMs)
          if (scenario === 'guard-open' && fault) packet.values.guardClosed = false
          if (scenario === 'emergency' && fault) packet.values.emergency = true
          const sequence = ++meterSequence
          if (scenario === 'meter-replay' && fault) frozenMeterSequence ??= sequence - 1
          if (!(scenario === 'meter-loss' && fault)) Object.assign(packet.values, { applicationCalibration: config.calibration.id, applicationMeterSequence: scenario === 'meter-replay' && fault ? frozenMeterSequence : sequence, applicationMeterAtMs: atMs, applicationPulseCount: Number(state.details.applicationPulseCount), applicationScaleRaw: Number(state.details.applicationScaleRaw), applicationPrimaryEncoder: Math.round(Number(state.details.applicationPrimary) * count), applicationMasterEncoder: Math.round(Number(state.details.applicationMaster) * count), applicationEnergyEncoder: Math.round(Number(state.details.applicationEnergy) * count) })
          return packet
        },
        observeIndependent(state, atMs, boardChannels, hostAvailable) {
          const snapshot = plant!.meterSnapshot(), yawRad = Number(state.details.yawRad)
          const probe: ApplicationProbe = { atMs, hostAvailable, positionM: [...state.positionM], yawRad, state: snapshot, boardChannels }
          releaseAmount += plant!.takeRelease(); releaseHostAvailable &&= hostAvailable; lastProbe = probe
          if (atMs % 20 === 0) { probes.push(probe); flushRelease(probe) }
        },
      }
    },
    faults(_name, atMs) {
      if (scenario !== 'nominal' && faultAtMs === null && plant && plant.meterSnapshot().emittedAmount > .0015) faultAtMs = Math.ceil((atMs + 400) / 20) * 20
      const active = activeFault(atMs)
      if (active) faultInjected = true
      const plantFault = active && ['empty', 'stuck-valve', 'master-stuck', 'blocked-flow'].includes(scenario) ? scenario : null
      plant?.setFault(plantFault)
      if (scenario === 'host-loss' && active) { hostLossAtMs ??= atMs; shutdownAt ??= atMs }
      return { hostLost: scenario === 'host-loss' && active, rcOverride: scenario === 'manual' && active, dropPosition: scenario === 'localization-loss' && active }
    },
  }
  const vehicle = runVehicleSimulation(profile, { scenario, seconds, neutralTailMs: 2000 })
  const actualPlant = plant as ApplicationPlant | null
  if (!actualPlant || !lastProbe) throw new Error('Application simulation produced no independent plant state')
  const final = actualPlant.meterSnapshot(), probe = lastProbe as ApplicationProbe
  if (probes.at(-1)?.atMs !== probe.atMs) probes.push(probe)
  flushRelease(probe)
  const requestedAtMs = hostLossAtMs ?? shutdownAt ?? vehicle.path.at(-1)?.atMs ?? 600
  const emittedBefore = releases.filter(release => release.atMs <= requestedAtMs).reduce((sum, release) => sum + release.amount, 0)
  const closureVerified = final.masterPosition <= .001 && final.energy <= .001 && final.flowPerSecond <= 1e-10 && final.atMs - requestedAtMs >= config.calibration.closingAllowanceMs
  const dry = testMode || !authorizeImplement
  const status: ApplicationRun['status'] = vehicle.status === 'completed' ? dry ? 'dry-completed' : 'completed' : vehicle.status === 'host-lost' ? 'host-lost' : vehicle.status === 'blocked' ? 'blocked' : 'incomplete'
  return { version: 1, evidence: 'owned-application-physics-simulation', physicalFlightEnabled: false, physicalApplicationVerified: false, physicalTrialEligible: false, options: { scenario, visitId, seconds, authorizeImplement, testMode }, config, plan, vehicle, inputs, decisions, releases, probes, final, shutdown: { requestedAtMs, finalAtMs: final.atMs, emittedAfterRequest: final.emittedAmount - emittedBefore, closureVerified, evidence: 'independent-modeled-plant-tail' }, status, reason: decisions.find(decision => decision.state === 'latched')?.reason ?? vehicle.fault ?? (dry ? 'application-dry-test' : vehicle.mission.reason), faultDemonstrated: scenario !== 'nominal' && faultInjected && final.emittedAmount > 0 && (status === 'blocked' || status === 'host-lost') }
}
