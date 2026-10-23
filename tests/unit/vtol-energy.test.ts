import { expect, test } from 'bun:test'
import { createVtolPlant } from '../../resources/functions/drone/vehicles/vtol/plant'
import { createVtolHoverProfile } from '../../resources/functions/drone/vehicles/vtol'
import { createVtolTransitionProfile } from '../../resources/functions/drone/vehicles/vtol/transition-profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { replayVehicleMission, validateVehicleMission } from '../../resources/functions/drone/missions/vehicle'
import { vtolElectricalMaximumW } from '../../resources/functions/drone/vehicles/vtol/power'
import type { VehicleControllerContext } from '../../resources/functions/drone/vehicles/types'

const environment = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }

// Public plant/sensor/runtime seams. Fictional electrical coefficients do not qualify hardware endurance.
test('simultaneous lift and pusher demand includes source loss and integrates chemical energy', () => {
  const plant = createVtolPlant({ electricalCapacityWh: 1, rotorsN: [4, 4, 4, 4], pusherThrustN: 4 })
  const initial = plant.snapshot().details
  // Independent decimal oracle: 128 W lift + 40 W pusher + 12 W auxiliaries,
  // 24 V source and 0.04 ohm series resistance. Source power includes I squared R.
  expect(initial.batteryLoadPowerW).toBeCloseTo(180, 10)
  expect(initial.batteryCurrentA).toBeCloseTo(7.596169655731083, 10)
  expect(initial.batteryTerminalV).toBeCloseTo(23.696153213770757, 10)
  expect(initial.batterySourcePowerW).toBeCloseTo(182.308071737546, 10)
  expect(initial.batteryEnergyUsedWh).toBe(0)
  const state = plant.step([4, 4, 4, 4, 4 / 14, 0, 0, 0], 0.004, environment)
  expect(state.details.batteryEnergyUsedWh).toBeCloseTo(0.00020256452415282887, 12)
  expect(state.details.batteryRemainingWh).toBeCloseTo(0.9997974354758472, 12)
  expect(state.details.batteryCutoff).toBe(false)
})

test('electrical demand retains independent rotor loading instead of using only total thrust', () => {
  const level = createVtolPlant({ electricalCapacityWh: 1, rotorsN: [4, 4, 4, 4] }).snapshot()
  const unequal = createVtolPlant({ electricalCapacityWh: 1, rotorsN: [8, 8, 0, 0] }).snapshot()
  expect(level.details.rotorThrustN).toBe(16)
  expect(unequal.details.rotorThrustN).toBe(16)
  expect(level.details.batteryLoadPowerW).toBeCloseTo(140, 10)
  expect(unequal.details.batteryLoadPowerW).toBeGreaterThan(190)
  expect(unequal.details.batterySourcePowerW).toBeGreaterThan(level.details.batterySourcePowerW as number)
})

test('invalid initial electrical state cannot silently become an unmetered plant', () => {
  for (const electricalCapacityWh of [null, 0, -1, NaN, Infinity]) expect(() => createVtolPlant({ electricalCapacityWh } as never)).toThrow()
  for (const energyUsedWh of [-1, 2, NaN, Infinity]) expect(() => createVtolPlant({ electricalCapacityWh: 1, energyUsedWh } as never)).toThrow()
  expect(() => createVtolPlant({ energyUsedWh: 0 } as never)).toThrow()
})

test('the simultaneous electrical ceiling includes every motor, surface and worst supply loss', () => {
  // Independent decimal oracle: peak load 948.023527181 W, source 1060.486739686 W at20V.
  expect(vtolElectricalMaximumW(12, 14)).toBe(1061)
  const plant = createVtolPlant({ electricalCapacityWh: 1, energyUsedWh: 0.99, rotorsN: [12, 12, 12, 12], pusherThrustN: 14 })
  const state = plant.step([12, 12, 12, 12, 1, 0.4, 0.4, 0.4], 0.004, environment)
  expect(state.details.batteryCutoff).toBe(false)
  expect(state.details.batteryLoadPowerW).toBeCloseTo(948.0235271806248, 8)
  expect(state.details.batterySourcePowerW).toBeGreaterThan(1050)
  expect(state.details.batterySourcePowerW).toBeLessThan(1061)
})

test('an electrical profile refuses an underfunded peak before creating a vehicle session', () => {
  const profile = createVtolTransitionProfile({ electrical: true })
  profile.mission.power.maxW = 1000
  let created = 0
  const factory = profile.createSession
  profile.createSession = () => { created++; return factory() }
  expect(() => { runVehicleSimulation(profile, { seconds: 2 }) }).toThrow('modeled source envelope')
  expect(created).toBe(0)
})

test('mission capacity must match the captured electrical plant before session allocation', () => {
  const profile = createVtolTransitionProfile({ electrical: true })
  profile.mission.power.availableWh = 101
  let created = 0
  const factory = profile.createSession
  profile.createSession = () => { created++; return factory() }
  expect(() => { runVehicleSimulation(profile, { seconds: 2 }) }).toThrow('modeled battery capacity')
  expect(created).toBe(0)
})

test('owned hover delivers delayed quantified energy to existing authority and mission observations', () => {
  const report = runVehicleSimulation(createVtolHoverProfile('hover', { electrical: true }), { seconds: 60 })
  expect(report.status).toBe('completed')
  expect(report).toHaveProperty('energy.evidence', 'modeled-vehicle-battery-v1')
  const first = report.path[0]!.measurement!
  expect(first.values.batteryCapacityWh).toBe(50)
  const last = report.path.at(-1)!.measurement!
  expect(last.values.batteryEnergyUsedWh).toBeGreaterThan(0)
  expect(last.values.batteryEnergyUsedWh).toBeLessThan(10)
  expect(last.capturedAtMs).toBeLessThan(report.path.at(-1)!.atMs)
  expect(report.trace.rows.at(-1)!.observation.batteryPercent).toBeGreaterThan(80)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
})

test('a captured supply cutoff withdraws authority even when chemical capacity remains', () => {
  const profile = createVtolHoverProfile('hover', { electrical: true }), factory = profile.createSession
  profile.createSession = () => {
    const session = factory(), render = session.renderMeasurement
    return { ...session, renderMeasurement(state, atMs, reference) {
      const packet = render(state, atMs, reference)
      if (atMs >= 3000) packet.values.batteryCutoff = true
      return packet
    } }
  }
  const report = runVehicleSimulation(profile, { seconds: 60 })
  expect(report.status).toBe('blocked')
  expect(report.fault).toBe('modeled-battery-supply-cutoff')
  expect(report.energy!.lastObservation!.cutoff).toBe(true)
  expect(report.energy!.lastObservation!.remainingPercentLowerBound).toBeGreaterThan(90)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
})

test('electrical integration remains atomic when the rigid-body step is refused', () => {
  const initial = { electricalCapacityWh: 1, positionM: [0, 0, -20] as [number, number, number], rotorsN: [4, 4, 4, 4] as [number, number, number, number], pusherThrustN: 4 }
  const plant = createVtolPlant(initial), reference = createVtolPlant(initial), before = plant.snapshot(), command = [4, 4, 4, 4, 4 / 14, 0, 0, 0]
  expect(() => plant.step(command, 0.004, { windMps: [1000000, 1000000, 0], currentMps: [0, 0, 0] })).toThrow()
  expect(plant.snapshot()).toEqual(before)
  expect(plant.step(command, 0.004, environment)).toEqual(reference.step(command, 0.004, environment))
})

test('an exhausted modeled source latches propulsion cutoff while retained rotor response coasts', () => {
  const plant = createVtolPlant({ electricalCapacityWh: 0.0001, rotorsN: [4, 4, 4, 4] }), demand = [12, 12, 12, 12, 1, 0.4, 0.4, 0.4]
  const first = plant.step(demand, 0.004, environment)
  expect(first.details.batteryCutoff).toBe(true)
  expect(first.details.rotorThrustN).toBeGreaterThan(0)
  expect(first.details.rotorThrustN).toBeLessThan(16)
  expect(first.details.pusherThrustN).toBe(0)
  let final = first
  for (let i = 0; i < 400; i++) final = plant.step(demand, 0.004, environment)
  expect(final.details.batteryEnergyUsedWh).toBe(0.0001)
  expect(final.details.batteryRemainingWh).toBe(0)
  expect(final.details.batterySourcePowerW).toBe(0)
  expect(final.details.batteryCurrentA).toBe(0)
  expect(final.details.batteryCutoff).toBe(true)
  expect(final.details.rotorThrustN).toBeLessThan(1e-8)
  expect(final.details.pusherThrustN).toBe(0)
})

test('default and explicitly disabled electrical profiles retain exact legacy reports', () => {
  const legacy = runVehicleSimulation(createVtolHoverProfile(), { seconds: 30 })
  const disabled = runVehicleSimulation(createVtolHoverProfile('hover', { electrical: false }), { seconds: 30 })
  expect(disabled).toEqual(legacy)
  expect(Object.hasOwn(legacy, 'energy')).toBe(false)
  expect(legacy.path.every(row => !Object.hasOwn(row.measurement!.values, 'batteryEnergyUsedWh'))).toBe(true)
})

test('the complete electrical route charges all phases without feeding plant truth into controls', () => {
  const profile = createVtolTransitionProfile({ electrical: true }), factory = profile.createSession
  let truthInput = false, controllerSamples = 0
  profile.createSession = () => {
    const session = factory(), controller = session.createController()
    return { ...session, createController: () => ({ step(context: VehicleControllerContext) {
      controllerSamples++
      if (Object.hasOwn(context, 'truthPositionM') || Object.hasOwn(context, 'details') || Object.hasOwn(context, 'energyUsedWh')) truthInput = true
      return controller.step(context)
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 150 })
  expect(report.status).toBe('completed')
  expect(controllerSamples).toBeGreaterThan(100)
  expect(truthInput).toBe(false)
  const rows = report.path.map(row => ({ row, used: row.measurement!.values.batteryEnergyUsedWh as number, source: row.measurement!.values.batterySourcePowerW as number }))
  expect(rows.every((r, i) => i === 0 || r.used >= rows[i - 1]!.used)).toBe(true)
  expect(rows.every(r => r.source <= 1061)).toBe(true)
  for (const task of ['depart', 'front', 'cruise-leg', 'back', 'land']) {
    const phase = rows.filter(r => r.row.mission.taskId === task)
    expect(phase.length).toBeGreaterThan(10)
    expect(phase.at(-1)!.used).toBeGreaterThan(phase[0]!.used)
  }
  const front = rows.filter(r => r.row.mission.taskId === 'front')
  // Independent lower bound: four rotors totaling10N require at least63.245553W,
  // a5N pusher55.901699W, and auxiliaries12W, before supply losses.
  expect(front.some(r => r.source > 131.147 && (r.row.measurement!.values.rotorThrustN as number) > 10 && (r.row.measurement!.values.pusherThrustN as number) > 5)).toBe(true)
  expect(report.budget).toEqual({ worstCaseMs: 131520, requiredWh: 43.84 })
  expect(report.energy!.lastObservation!.energyUsedWh).toBeGreaterThan(0)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeLessThan(report.budget.requiredWh)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

for (const mutation of ['missing-energy', 'changed-capacity', 'energy-reset', 'over-envelope', 'impossible-current', 'reserve'] as const) test(`captured electrical ${mutation} revokes rather than substituting a full battery`, () => {
  const profile = createVtolHoverProfile('hover', { electrical: true }), factory = profile.createSession
  profile.createSession = () => {
    const session = factory(), render = session.renderMeasurement
    return { ...session, renderMeasurement(state, atMs, reference) {
      const packet = render(state, atMs, reference)
      if (atMs >= 3000) {
        if (mutation === 'missing-energy') delete packet.values.batteryEnergyUsedWh
        if (mutation === 'changed-capacity') packet.values.batteryCapacityWh = 100
        if (mutation === 'energy-reset') packet.values.batteryEnergyUsedWh = 0
        if (mutation === 'over-envelope') packet.values.batterySourcePowerW = 1062
        if (mutation === 'impossible-current') packet.values.batteryCurrentA = 100
        if (mutation === 'reserve') packet.values.batteryEnergyUsedWh = 35
      }
      return packet
    } }
  }
  const report = runVehicleSimulation(profile, { seconds: 30 })
  expect(report.status).toBe('blocked')
  expect(report.path.at(-1)!.atMs).toBeLessThanOrEqual(3200)
  expect(report.fault).toContain('battery')
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

test('host loss keeps the last qualified battery separate from continuing independent consumption', () => {
  const profile = createVtolHoverProfile('host-loss', { electrical: true }), factory = profile.createSession
  let independentEnergyWh = 0, independentAtMs = 0
  profile.createSession = () => {
    const session = factory()
    return { ...session, observeIndependent(state, atMs) { independentEnergyWh = state.details.batteryEnergyUsedWh as number; independentAtMs = atMs } }
  }
  const report = runVehicleSimulation(profile, { seconds: 30, neutralTailMs: 1000 })
  expect(report.status).toBe('host-lost')
  expect(report.energy!.lastObservation!.observedAtMs).toBe(2980)
  expect(report.energy!.lastObservation!.capturedAtMs).toBeLessThan(2980)
  expect(independentAtMs).toBe(4100)
  expect(independentEnergyWh).toBeGreaterThan(report.energy!.lastObservation!.energyUsedWh)
  expect(report.board.fault).toBe('output-lease-expired')
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
})

test('modeled energy keeps advancing while an actual hover mission is paused', () => {
  const report = runVehicleSimulation(createVtolHoverProfile('hover', { electrical: true }), { seconds: 60, missionActions: [{ atMs: 3000, action: 'pause' }, { atMs: 10000, action: 'resume' }] })
  expect(report.status).toBe('completed')
  const paused = report.path.filter(row => row.mission.state === 'paused')
  expect(paused.length).toBeGreaterThan(100)
  expect(paused.at(-1)!.measurement!.values.batteryEnergyUsedWh).toBeGreaterThan(paused[0]!.measurement!.values.batteryEnergyUsedWh as number)
  expect(paused.at(-1)!.mission.taskId).toBe(paused[0]!.mission.taskId)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

function electricalRecovery(sourceId: 'initial-hover' | 'front' | 'back') {
  const profile = createVtolTransitionProfile({ electrical: true }), source = profile.mission.tasks.find(task => task.id === sourceId)!
  if (source.kind !== 'vtol-mode') throw new Error('Expected mode task')
  source.onFailure = 'energy-hover'
  profile.mission.tasks.push(
    { id: 'energy-hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: sourceId === 'back' ? 40000 : 45000, next: 'energy-land' },
    { id: 'energy-land', kind: 'land', positionM: [sourceId === 'back' ? 180 : 0, 0, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: sourceId === 'back' ? 30000 : 35000 },
  )
  return profile
}

// Front failure is116520ms, below the131520ms normal route. Back failure is176520ms.
for (const [source, atMs, expectedMs, expectedWh] of [['initial-hover', 700, 131520, 43.84], ['front', 13000, 131520, 43.84], ['back', 30000, 176520, 58.84]] as const) test(`electrical ${source} abort accounts for the complete declared hover and landing route`, () => {
  const report = runVehicleSimulation(electricalRecovery(source), { seconds: 180, missionActions: [{ atMs, action: 'abort' }] })
  expect(report.mission.state).toBe('aborted')
  expect(report.mission.reason).toBe('vtol-abort-landed')
  expect(report.budget.worstCaseMs).toBe(expectedMs)
  expect(report.budget.requiredWh).toBeCloseTo(expectedWh, 10)
  expect(report.energy!.model.maximumSourceW).toBe(1061)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeGreaterThan(0)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeLessThan(expectedWh)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(report.path.filter(row => row.mission.taskId === 'energy-land').some(row => (row.measurement!.values.batteryEnergyUsedWh as number) > 0)).toBe(true)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

test('energy preflight includes recovery landing even when the nominal route alone is affordable', () => {
  const normal = createVtolTransitionProfile({ electrical: true })
  normal.mission.power.reservePercent = 50
  expect(validateVehicleMission(normal.mission).requiredWh).toBe(43.84)
  const profile = electricalRecovery('back')
  profile.mission.power.reservePercent = 50
  let created = 0
  const factory = profile.createSession
  profile.createSession = () => { created++; return factory() }
  expect(() => { runVehicleSimulation(profile, { seconds: 180 }) }).toThrow('preserve energy reserve')
  expect(created).toBe(0)
})

test('malformed battery envelopes and accessors are refused before session creation', () => {
  let getterCalls = 0
  const accessor = { evidence: 'modeled-vehicle-battery-v1', get capacityWh() { getterCalls++; return 100 }, maximumSourceW: 1061 }
  for (const input of [null, {}, [], accessor, { evidence: 'physical', capacityWh: 100, maximumSourceW: 1061 }, { evidence: 'modeled-vehicle-battery-v1', capacityWh: '100', maximumSourceW: 1061 }, { evidence: 'modeled-vehicle-battery-v1', capacityWh: 100, maximumSourceW: Infinity }, { evidence: 'modeled-vehicle-battery-v1', capacityWh: 100, maximumSourceW: 0 }, { evidence: 'modeled-vehicle-battery-v1', capacityWh: 100, maximumSourceW: 1061, extra: true }]) {
    const profile = createVtolTransitionProfile({ electrical: true }), factory = profile.createSession
    let created = 0
    profile.batteryModel = input as never
    profile.createSession = () => { created++; return factory() }
    expect(() => { runVehicleSimulation(profile, { seconds: 2 }) }).toThrow('modeled vehicle battery envelope')
    expect(created).toBe(0)
  }
  expect(getterCalls).toBe(0)
})

test('electrical sessions and returned energy views cannot mutate another run', () => {
  const profile = createVtolHoverProfile('hover', { electrical: true }), first = profile.createSession().createPlant(), second = profile.createSession().createPlant()
  const before = second.snapshot()
  first.step([6, 6, 6, 6, 0, 0, 0, 0], 0.004, environment)
  expect(first.snapshot().details.batteryEnergyUsedWh).toBeGreaterThan(0)
  expect(second.snapshot()).toEqual(before)
  const exposed = first.snapshot()
  exposed.details.batteryEnergyUsedWh = -100
  expect(first.snapshot().details.batteryEnergyUsedWh).toBeGreaterThan(0)
  expect(() => { profile.batteryModel!.capacityWh = 1 }).toThrow()
})

test('recovery hover and landing retain measured consumption across an explicit held resume', () => {
  const report = runVehicleSimulation(electricalRecovery('back'), { seconds: 180, missionActions: [{ atMs: 30000, action: 'recover' }, { atMs: 80000, action: 'resume' }] })
  expect(report.mission.state).toBe('completed')
  expect(report.mission.reason).toBe('vtol-recovery-landed')
  const held = report.path.filter(row => row.mission.state === 'paused')
  expect(held.length).toBeGreaterThan(100)
  expect(held.at(-1)!.measurement!.values.batteryEnergyUsedWh).toBeGreaterThan(held[0]!.measurement!.values.batteryEnergyUsedWh as number)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeGreaterThan(held.at(-1)!.measurement!.values.batteryEnergyUsedWh as number)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

test('electrical recovery holds cannot pause global endurance or claim a landing on expiry', () => {
  const report = runVehicleSimulation(electricalRecovery('back'), { seconds: 180, missionActions: [{ atMs: 30000, action: 'pause' }] })
  expect(report.mission.state).toBe('blocked')
  expect(report.mission.reason).toBe('mission-endurance-exhausted')
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(false)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeGreaterThan(1)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeLessThan(report.budget.requiredWh)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

test('an open-circuit modeled pusher times out into electrically accounted hover and landing', () => {
  const profile = electricalRecovery('front'), factory = profile.createSession
  profile.createSession = () => {
    const session = factory(), createPlant = session.createPlant
    return { ...session, createPlant() {
      const plant = createPlant()
      return { snapshot: plant.snapshot, step(input, dtS, world) {
        const commanded = [...input]
        commanded[4] = 0
        return plant.step(commanded, dtS, world)
      } }
    } }
  }
  const report = runVehicleSimulation(profile, { seconds: 150 })
  expect(report.mission.state).toBe('completed')
  expect(report.mission.reason).toBe('vtol-recovery-landed')
  expect(report.mission.recovery!.cause).toBe('timeout')
  expect(report.path.some(row => row.mission.taskId === 'cruise-leg')).toBe(false)
  expect(report.path.every(row => row.measurement!.values.pusherThrustN === 0)).toBe(true)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeGreaterThan(0)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeLessThan(report.budget.requiredWh)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})
