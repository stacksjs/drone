import type { ApplicationOptions, ApplicationPlan } from './types'
import type { AerialApplicationProbe, AerialApplicationRun, ApplicationDecision, ApplicationGrant, ApplicationHostInput, ApplicationMeterFeedback, ApplicationPlant, ApplicationProbe, ApplicationRun } from './runtime-types'
import type { VehicleProfile } from '../vehicles/types'
import { createRigidBody } from '../controls/physics'
import { quaternionEuler } from '../estimation/frames'
import { createGroundSession, createGroundProfile } from '../vehicles/ground/profile'
import { createGroundOdometry } from '../vehicles/ground/odometry'
import { runVehicleSimulation } from '../vehicles/runtime'
import { createMultirotorPlant, createMultirotorProfile, createMultirotorSession } from '../vehicles/multirotor/profile'
import { applicationNeutralTailMs, planAerialApplication, planApplication } from './planner'
import { exampleApplicationConfig } from './fixtures'
import { createApplicationController } from './controller'
import { createApplicationPlant } from './plant'
import { applicationFlightMotion, createApplicationFlightPower, observeApplicationFlight } from './aerial'

export const applicationScenarios = ['nominal', 'empty', 'stuck-valve', 'master-stuck', 'blocked-flow', 'meter-loss', 'meter-replay', 'weather', 'manual', 'host-loss', 'emergency', 'localization-loss', 'guard-open', 'lease-expiry'] as const
export function simulateApplication(options: ApplicationOptions = {}): ApplicationRun {
  return runApplication(planApplication(options.config ?? exampleApplicationConfig()), options) as ApplicationRun
}

export function simulateAerialApplication(declaration: unknown, options: Omit<ApplicationOptions, 'config'> = {}): AerialApplicationRun {
  return runApplication(planAerialApplication(declaration), options) as AerialApplicationRun
}

/** Both carrier profiles run the same bounded instrument and independent plant evidence lifecycle. */
function runApplication(plan: ApplicationPlan, options: Omit<ApplicationOptions, 'config'>): ApplicationRun<ApplicationHostInput> {
  const scenario = options.scenario ?? 'nominal', visitId = options.visitId ?? 'application-visit-1', seconds = options.seconds ?? 120
  const authorizeImplement = options.authorizeImplement ?? false, testMode = options.testMode ?? true
  if (!applicationScenarios.includes(scenario) || !/^[a-z][a-z0-9-]{0,63}$/.test(visitId) || typeof authorizeImplement !== 'boolean' || typeof testMode !== 'boolean' || !Number.isSafeInteger(seconds) || seconds < 2 || seconds > 180) throw new RangeError('Invalid application options')
  const config = plan.config
  const aerial = 'aircraft' in plan ? plan as AerialApplicationRun['plan'] : null
  const flightPower = aerial ? createApplicationFlightPower(aerial) : null
  const neutralTailMs = applicationNeutralTailMs(config)
  const inputs: ApplicationHostInput[] = [], decisions: ApplicationDecision[] = [], probes: (ApplicationProbe | AerialApplicationProbe)[] = [], releases: ApplicationRun['releases'] = []
  let plant: ApplicationPlant | null = null, faultAtMs: number | null = null, hostLossAtMs: number | null = null, faultInjected = false
  let lastTaskId: string | null = null, lastDecision: ApplicationDecision | null = null, shutdownAt: number | null = null
  let releaseAmount = 0, releaseHostAvailable = true, lastProbe: ApplicationProbe | AerialApplicationProbe | null = null
  function activeFault(atMs: number) {
    if (faultAtMs === null || atMs < faultAtMs) return false
    return scenario === 'master-stuck' || scenario === 'stuck-valve' || atMs < faultAtMs + 2000
  }
  function flushRelease(probe: ApplicationProbe | AerialApplicationProbe) {
    if (releaseAmount > 0) {
      const velocity = 'flight' in probe ? probe.flight.velocityMps : null
      releases.push({ atMs: probe.atMs, amount: releaseAmount, positionM: [...probe.positionM], yawRad: probe.yawRad, windMps: [...config.weather.windMps], ...(velocity ? { releaseVelocityMps: [velocity[0], velocity[1]] as [number, number] } : {}), taskId: releaseHostAvailable ? lastTaskId : null, hostAvailable: releaseHostAvailable, positionEvidence: 'modeled-plant-truth' })
    }
    releaseAmount = 0; releaseHostAvailable = true
  }
  const baseProfile = aerial ? createMultirotorProfile() : createGroundProfile('nominal')
  const profile: VehicleProfile = {
    ...baseProfile, scenario, name: `Owned inert ${config.implement.type} application`, scenarios: applicationScenarios, mission: plan.mission,
    ...(aerial ? { batteryModel: { evidence: 'modeled-vehicle-battery-v1' as const, capacityWh: aerial.aircraft.availableWh, maximumSourceW: aerial.mission.power.maxW } } : {}),
    actuators: [...baseProfile.actuators, ...['primary-meter', 'independent-master-isolation', 'pump-or-auger-energy'].map(name => ({ name, unit: 'normalized' as const, min: 0, max: 1, neutral: 0 }))],
    createSession() {
      const base = aerial ? createMultirotorSession(applicationFlightMotion(aerial)) : createGroundSession()
      const baseController = base.createController(), odometry = aerial ? null : createGroundOdometry()
      const controller = createApplicationController(config, { visitId, authorizeImplement, testMode }, aerial?.aircraft.operatingHeightM)
      let meterSequence = 0, frozenMeterSequence: number | null = null, grantSequence = 0, lastGrantAt = -Infinity, granted = false
      const implementPlant = createApplicationPlant(config, {
        startAtMs: 600,
        ...(aerial
          ? { createCarrier: readRemaining => createMultirotorPlant(createRigidBody({ positionM: [0, 0, -.1], groundDownM: -.1 }), () => aerial.load.installedMassKg + readRemaining() * config.material.densityKgPerL!) }
          : { ground: base.createPlant() }),
      })
      plant = implementPlant
      const poweredPlant = flightPower?.wrapPlant(implementPlant) ?? implementPlant
      return {
        ...(base.targetHeadingRad ? { targetHeadingRad: base.targetHeadingRad } : {}),
        createPlant: () => poweredPlant,
        createController: () => ({ step(context) {
          const motion = odometry ? { ground: odometry.step(context.measurement, context.estimate, context.nowMs) } : { flight: observeApplicationFlight(context) }
          const v = context.measurement?.values
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
          const input: ApplicationHostInput = { atMs: context.nowMs, enabled: context.enabled, reference, missionState: context.mission.state, taskId: context.mission.taskId, ...motion, feedback, weather, grant, emergency: scenario === 'emergency' && activeFault(context.nowMs) }
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
          if (flightPower) Object.assign(packet.values, flightPower.measurement(), { guardClosed: true })
          if (scenario === 'guard-open' && fault) packet.values.guardClosed = false
          if (scenario === 'emergency' && fault) packet.values.emergency = true
          const sequence = ++meterSequence
          if (scenario === 'meter-replay' && fault) frozenMeterSequence ??= sequence - 1
          if (!(scenario === 'meter-loss' && fault)) Object.assign(packet.values, { applicationCalibration: config.calibration.id, applicationMeterSequence: scenario === 'meter-replay' && fault ? frozenMeterSequence : sequence, applicationMeterAtMs: atMs, applicationPulseCount: Number(state.details.applicationPulseCount), applicationScaleRaw: Number(state.details.applicationScaleRaw), applicationPrimaryEncoder: Math.round(Number(state.details.applicationPrimary) * count), applicationMasterEncoder: Math.round(Number(state.details.applicationMaster) * count), applicationEnergyEncoder: Math.round(Number(state.details.applicationEnergy) * count) })
          return packet
        },
        observeIndependent(state, atMs, boardChannels, hostAvailable) {
          const snapshot = implementPlant.meterSnapshot(), yawRad = aerial ? quaternionEuler(state.quaternionWxyz)[2] : Number(state.details.yawRad)
          const probe = { atMs, hostAvailable, positionM: [...state.positionM] as ApplicationProbe['positionM'], yawRad, state: snapshot, boardChannels, ...(flightPower ? { flight: flightPower.probe(state, snapshot.remainingAmount) } : {}) }
          releaseAmount += implementPlant.takeRelease(); releaseHostAvailable &&= hostAvailable; lastProbe = probe
          if (atMs % 20 === 0) { probes.push(probe); flushRelease(probe) }
        },
      }
    },
    // eslint-disable-next-line
    faults(scenarioName, atMs, phase = 'host') {
      if (phase === 'host' && scenario !== 'nominal' && faultAtMs === null && plant && plant.meterSnapshot().emittedAmount > .0015) faultAtMs = Math.ceil((atMs + 400) / 20) * 20
      if (phase === 'host' && activeFault(atMs)) faultInjected = true
      const active = faultInjected && activeFault(atMs)
      const plantFault = active && ['empty', 'stuck-valve', 'master-stuck', 'blocked-flow'].includes(scenario) ? scenario : null
      plant?.setFault(plantFault)
      if (scenario === 'host-loss' && active) { hostLossAtMs ??= atMs; shutdownAt ??= atMs }
      return { hostLost: scenario === 'host-loss' && active, rcOverride: scenario === 'manual' && active, dropPosition: scenario === 'localization-loss' && active,
        ...(aerial ? { windMps: [...config.weather.windMps, 0] as [number, number, number] } : {}) }
    },
  }
  const vehicle = runVehicleSimulation(profile, { scenario, seconds, neutralTailMs })
  const actualPlant = plant as ApplicationPlant | null
  if (!actualPlant || !lastProbe) throw new Error('Application simulation produced no independent plant state')
  const final = actualPlant.meterSnapshot(), probe = lastProbe as ApplicationProbe | AerialApplicationProbe
  if (probes.at(-1)?.atMs !== probe.atMs) probes.push(probe)
  flushRelease(probe)
  const requestedAtMs = hostLossAtMs ?? shutdownAt ?? vehicle.path.at(-1)?.atMs ?? 600
  const emittedBefore = releases.filter(release => release.atMs <= requestedAtMs).reduce((sum, release) => sum + release.amount, 0)
  const closureVerified = final.masterPosition <= .001 && final.energy <= .001 && final.flowPerSecond <= 1e-10 && final.atMs - requestedAtMs >= config.calibration.closingAllowanceMs
  const dry = testMode || !authorizeImplement
  const latched = decisions.find(decision => decision.state === 'latched')
  const status: ApplicationRun['status'] = vehicle.status === 'host-lost' ? 'host-lost' : vehicle.status === 'blocked' || aerial && latched ? 'blocked' : vehicle.status === 'completed' ? dry ? 'dry-completed' : 'completed' : 'incomplete'
  return { version: 1, evidence: 'owned-application-physics-simulation', physicalFlightEnabled: false, physicalApplicationVerified: false, physicalTrialEligible: false, options: { scenario, visitId, seconds, authorizeImplement, testMode }, config, plan, vehicle, inputs, decisions, releases, probes, final, shutdown: { requestedAtMs, finalAtMs: final.atMs, emittedAfterRequest: final.emittedAmount - emittedBefore, closureVerified, evidence: 'independent-modeled-plant-tail' }, status, reason: latched?.reason ?? vehicle.fault ?? (dry ? 'application-dry-test' : final.emittedAmount === 0 && status === 'completed' ? 'application-no-material-discharged' : vehicle.mission.reason), faultDemonstrated: scenario !== 'nominal' && faultInjected && final.emittedAmount > 0 && (status === 'blocked' || status === 'host-lost') }
}
