import { expect, test } from 'bun:test'
import { createVtolTransitionProfile } from '../../resources/functions/drone/vehicles/vtol/transition-profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { createVehicleMissionEngine, parseVehicleMissionTrace, replayVehicleMission, validateVehicleMission } from '../../resources/functions/drone/missions/vehicle'
import { createVtolVehicleHoverController } from '../../resources/functions/drone/vehicles/vtol/controller'
import { createVtolFlightController } from '../../resources/functions/drone/vehicles/vtol/flight-controller'
import type { VehicleControllerContext } from '../../resources/functions/drone/vehicles/types'

function declaredRecovery(sourceTask: 'initial-hover' | 'front' | 'back') {
  const profile = createVtolTransitionProfile(), source = profile.mission.tasks.find(task => task.id === sourceTask)!
  if (source.kind !== 'vtol-mode') throw new Error('Expected a VTOL mode task')
  source.onFailure = 'recover-hover'
  profile.mission.tasks.push(
    { id: 'recover-hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: sourceTask === 'back' ? 40000 : 45000, next: 'recover-land' },
    { id: 'recover-land', kind: 'land', positionM: [sourceTask === 'back' ? 180 : 0, 0, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: sourceTask === 'back' ? 30000 : 35000 },
  )
  return profile
}

for (const mutation of ['missing-cancel', 'foreign-failed-task', 'missing-both-records', 'changed-after-admission'] as const) test(`pending initial-hover recovery rejects ${mutation} before confirmation`, () => {
  const profile = declaredRecovery('initial-hover'), createSession = profile.createSession, inputs: VehicleControllerContext[] = []
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(c) { if (c.nowMs <= 740) inputs.push(structuredClone(c)); return controller.step(c) } }) }
  }
  expect(runVehicleSimulation(profile, { seconds: 180, missionActions: [{ atMs: 700, action: 'abort' }] }).mission.reason).toBe('vtol-abort-landed')
  const index = inputs.findIndex(c => c.nowMs === (mutation === 'changed-after-admission' ? 720 : 700)), controller = createVtolFlightController()
  expect(index).toBeGreaterThan(0)
  for (const c of inputs.slice(0, index)) expect(controller.step(c).inhibited).toBe(false)
  const altered = structuredClone(inputs[index]!)
  if (mutation === 'foreign-failed-task' || mutation === 'changed-after-admission') altered.mission.recovery!.failedTaskId = 'foreign-task'
  else {
    delete altered.mission.transition!.supersedesEventId
    if (mutation === 'missing-both-records') delete altered.mission.recovery
  }
  const refused = controller.step(altered)
  expect(refused.inhibited).toBe(true)
  expect(refused.transition).toBeUndefined()
  expect(refused.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(controller.step(inputs[index + 1]!).inhibited).toBe(true)
})

test('replacement hover cannot invent or change the cancelled request, source reference or recovery scope', () => {
  const profile = declaredRecovery('front'), createSession = profile.createSession, inputs: VehicleControllerContext[] = []
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(c) { if (c.nowMs <= 13040) inputs.push(structuredClone(c)); return controller.step(c) } }) }
  }
  expect(runVehicleSimulation(profile, { seconds: 160, missionActions: [{ atMs: 13000, action: 'abort' }] }).mission.reason).toBe('vtol-abort-landed')
  const index = inputs.findIndex(c => c.nowMs === 13000)
  for (const change of [
    (c: VehicleControllerContext) => { c.mission.transition!.supersedesEventId = 'foreign-event' },
    (c: VehicleControllerContext) => { delete c.mission.transition!.supersedesEventId },
    (c: VehicleControllerContext) => { c.mission.transition!.mode = 'cruise' },
    (c: VehicleControllerContext) => { c.mission.transition!.eventId = c.mission.transition!.supersedesEventId! },
    (c: VehicleControllerContext) => { delete c.mission.recovery },
    (c: VehicleControllerContext) => { c.mission.recovery!.failedEventId = 'foreign-event' },
    (c: VehicleControllerContext) => { c.mission.recovery!.hoverTaskId = 'other-hover' },
    (c: VehicleControllerContext) => { c.mission.recovery!.triggeredAtMs += 20 },
    (c: VehicleControllerContext) => { c.mission.transition!.reference = 'foreign-reference' },
    (c: VehicleControllerContext) => { c.controlRate!.capturedAtMs -= 1000 },
    (c: VehicleControllerContext) => { c.estimate.localPosition!.origin!.ellipsoidHeightM += 1 },
    (c: VehicleControllerContext) => { c.nowMs -= 20 },
  ]) {
    const controller = createVtolFlightController()
    for (const c of inputs.slice(0, index)) expect(controller.step(c).inhibited).toBe(false)
    const altered = structuredClone(inputs[index]!)
    change(altered)
    const refused = controller.step(altered)
    expect(refused.inhibited).toBe(true)
    expect(refused.transition).toBeUndefined()
    expect(refused.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(controller.step(inputs[index + 1]!).inhibited).toBe(true)
  }
})

test('recovered hover cannot pause global endurance or evade the bounded serialized replay contract', () => {
  const report = runVehicleSimulation(declaredRecovery('front'), { seconds: 180, missionActions: [{ atMs: 13000, action: 'pause' }] })
  expect(report.status).toBe('blocked')
  expect(report.mission.reason).toBe('mission-endurance-exhausted')
  expect(report.mission.elapsedMs).toBeGreaterThan(report.budget.worstCaseMs)
  expect(report.mission.elapsedMs).toBeLessThanOrEqual(report.budget.worstCaseMs + 20)
  const paused = report.trace.rows.filter(row => row.result.state === 'paused')
  expect(paused.at(-1)!.observation.batteryPercent).toBeLessThan(paused[0]!.observation.batteryPercent)
  expect(report.path.some(row => row.mission.taskId === 'recover-land' && row.mission.state === 'running')).toBe(false)
  expect(report.finalTruthPositionM[2]).toBeLessThan(-1)
  const serialized = JSON.stringify(report.trace)
  expect(new TextEncoder().encode(serialized).length).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(replayVehicleMission(parseVehicleMissionTrace(serialized)).snapshot()).toEqual(report.mission)
  const altered = structuredClone(report.trace)
  altered.rows.find(row => row.result.recovery)!.result.recovery!.failedEventId = 'foreign-event'
  expect(() => parseVehicleMissionTrace(JSON.stringify(altered))).toThrow('decision mismatch')
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
})

test('late feedback from a cancelled transition cannot complete or resume its replacement', () => {
  const report = runVehicleSimulation(declaredRecovery('front'), { seconds: 160, missionActions: [{ atMs: 13000, action: 'abort' }] })
  const engine = createVehicleMissionEngine(report.trace.plan)
  for (const row of report.trace.rows.filter(row => row.observation.nowMs <= 13000)) engine.step(row.observation, row.action ?? undefined)
  const late = structuredClone(report.trace.rows.find(row => row.observation.nowMs === 13020)!.observation)
  late.transition = structuredClone(report.trace.rows.find(row => row.observation.nowMs === 13000)!.observation.transition!)
  expect(late.transition!.taskId).toBe('front')
  expect(engine.step(late).reason).toBe('vtol-transition-outcome-uncertain')
  expect(engine.snapshot().state).toBe('blocked')
  const next = report.trace.rows.find(row => row.observation.nowMs === 13040)!.observation
  expect(engine.step(next, 'resume').state).toBe('blocked')
})

test('a real hover-only controller rejection follows the declared failure route without certifying cruise', () => {
  const profile = declaredRecovery('front'), createSession = profile.createSession
  profile.createSession = () => ({ ...createSession(), createController: createVtolVehicleHoverController })
  const report = runVehicleSimulation(profile, { seconds: 160 })
  expect(report.mission.reason).toBe('vtol-recovery-landed')
  expect(report.mission.recovery?.cause).toBe('controller-aborted')
  expect(report.trace.rows.some(row => row.observation.transition?.outcome === 'aborted' && row.observation.transition.reason === 'hover-only-controller')).toBe(true)
  expect(report.path.some(row => row.mission.taskId === 'cruise-leg')).toBe(false)
  expect(report.path.every(row => row.actuators[4] === 0)).toBe(true)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

test('invalid or unaffordable failure routes are rejected before allocating session resources', () => {
  for (const mutate of [
    (p: ReturnType<typeof declaredRecovery>) => { Object.assign(p.mission.tasks.find(t => t.id === 'back')!, { onFailure: 'missing' }) },
    (p: ReturnType<typeof declaredRecovery>) => { Object.assign(p.mission.tasks.find(t => t.id === 'recover-hover')!, { mode: 'cruise' }) },
    (p: ReturnType<typeof declaredRecovery>) => { Object.assign(p.mission.tasks.find(t => t.id === 'recover-hover')!, { onFailure: 'recover-hover' }) },
    (p: ReturnType<typeof declaredRecovery>) => { Object.assign(p.mission.tasks.find(t => t.id === 'recover-land')!, { kind: 'waypoint' }) },
    (p: ReturnType<typeof declaredRecovery>) => { Object.assign(p.mission.tasks.find(t => t.id === 'recover-land')!, { next: 'back' }) },
    (p: ReturnType<typeof declaredRecovery>) => { const land = p.mission.tasks.find(t => t.id === 'recover-land')!; if ('positionM' in land) land.positionM[2] = -1 },
    (p: ReturnType<typeof declaredRecovery>) => { Object.assign(p.mission.tasks.find(t => t.id === 'front')!, { next: 'recover-hover' }) },
    (p: ReturnType<typeof declaredRecovery>) => { Object.assign(p.mission.tasks.find(t => t.id === 'back')!, { next: 'back' }) },
    (p: ReturnType<typeof declaredRecovery>) => { Object.assign(p.mission.tasks.find(t => t.id === 'recover-hover')!, { timeoutMs: 45000 }); Object.assign(p.mission.tasks.find(t => t.id === 'recover-land')!, { timeoutMs: 35000 }) },
    (p: ReturnType<typeof declaredRecovery>) => { p.mission.power.availableWh = 84 },
  ]) {
    const profile = declaredRecovery('back')
    mutate(profile)
    let allocations = 0
    profile.createSession = () => { allocations++; throw new Error('Resources must remain unallocated') }
    expect(() => runVehicleSimulation(profile, { seconds: 180 })).toThrow()
    expect(allocations).toBe(0)
  }
  const budget = validateVehicleMission(declaredRecovery('back').mission)
  expect(budget.worstCaseMs).toBe(176520)
  expect(budget.requiredWh).toBeCloseTo(58.84, 8)
})

for (const [atMs, taskId] of [[15000, 'recover-hover'], [40500, 'recover-land']] as const) {
  for (const failure of ['dropImu', 'dropPosition', 'dropVehicleSensor', 'rcOverride', 'kill', 'hostLost'] as const) test(`recovery ${taskId} cannot bypass ${failure}`, () => {
    const profile = declaredRecovery('front')
    profile.faults = (_scenario, nowMs) => nowMs >= atMs ? { [failure]: true } : {}
    const report = runVehicleSimulation(profile, { seconds: 180, missionActions: [{ atMs: 13000, action: 'pause' }, { atMs: 40000, action: 'resume' }] })
    expect(report.path.filter(row => row.atMs < atMs).at(-1)!.mission.taskId).toBe(taskId)
    expect(report.status).toBe(failure === 'hostLost' ? 'host-lost' : 'blocked')
    expect(report.mission.reason).not.toBe('vtol-recovery-landed')
    expect(report.mission.reason).not.toBe('vtol-abort-landed')
    expect(report.finalTruthPositionM[2]).toBeLessThan(-1)
    expect(report.authority.events.filter(event => event.to === 'autonomous')).toHaveLength(1)
    expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(report.board.expiresAtMs).toBeNull()
    if (failure === 'hostLost') {
      expect(report.board.fault).toBe('output-lease-expired')
      expect(report.authority.lastCheckedAtMs).toBeLessThan(atMs)
    }
    else {
      expect(report.mission.state).toBe('blocked')
      expect(report.path.at(-1)!.atMs).toBeLessThanOrEqual(atMs + 500)
      expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
    }
  })
}

test('an early resume and repeated recovery cannot skip observed hover or extend its request', () => {
  const report = runVehicleSimulation(declaredRecovery('front'), { seconds: 180, missionActions: [{ atMs: 13000, action: 'pause' }, { atMs: 13200, action: 'resume' }, { atMs: 13400, action: 'recover' }, { atMs: 40000, action: 'resume' }] })
  const requests = report.path.filter(row => row.mission.taskId === 'recover-hover').map(row => row.mission.transition!)
  expect(new Set(requests.map(request => request.eventId)).size).toBe(1)
  expect(requests.every(request => request.issuedAtMs === 13000 && request.expiresAtMs === 58000)).toBe(true)
  expect(report.path.find(row => row.atMs === 13200)!.mission.state).toBe('running')
  const observedHover = report.trace.rows.find(row => row.observation.transition?.taskId === 'recover-hover' && row.observation.transition.outcome === 'confirmed')
  expect(observedHover).toBeDefined()
  expect(observedHover!.observation.nowMs).toBeGreaterThan(13400)
  expect(observedHover!.observation.nowMs).toBeLessThan(40000)
  expect(observedHover!.result.state).toBe('paused')
  expect(report.path.filter(row => row.atMs >= 13200 && row.atMs < observedHover!.observation.nowMs).every(row => row.mission.state === 'running' && row.mission.taskId === 'recover-hover')).toBe(true)
  expect(report.path.find(row => row.atMs === 39980)!.mission.state).toBe('paused')
  expect(report.mission.reason).toBe('vtol-recovery-landed')
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

for (const abortAtMs of [15000, 20000]) test(`an abort at ${abortAtMs} upgrades recovery to contact without resetting its original epoch`, () => {
  const report = runVehicleSimulation(declaredRecovery('front'), { seconds: 180, missionActions: [{ atMs: 13000, action: 'pause' }, { atMs: abortAtMs, action: 'abort' }] })
  expect(report.mission.state).toBe('aborted')
  expect(report.mission.reason).toBe('vtol-abort-landed')
  expect(report.mission.recovery).toMatchObject({ triggeredAtMs: 13000, cause: 'operator-pause', abortRequestedAtMs: abortAtMs })
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(report.authority.events.filter(event => event.to === 'autonomous')).toHaveLength(1)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

for (const sourceTask of ['initial-hover', 'front', 'back'] as const) test(`a ${sourceTask} abort before its first command dispatch does not invent a cancelled event`, () => {
  const baseline = runVehicleSimulation(declaredRecovery(sourceTask), { seconds: 160 })
  const firstRequest = baseline.path.find(row => row.mission.transition?.taskId === sourceTask)
  expect(firstRequest).toBeDefined()
  const atMs = firstRequest!.atMs
  const report = runVehicleSimulation(declaredRecovery(sourceTask), { seconds: 180, missionActions: [{ atMs, action: 'abort' }] })
  expect(report.mission.reason).toBe('vtol-abort-landed')
  expect(report.mission.recovery?.failedEventId).toBeNull()
  const replacement = report.path.find(row => row.mission.taskId === 'recover-hover')!.mission.transition!
  expect(replacement.supersedesEventId).toBeUndefined()
  expect(report.path.some(row => row.mission.transition?.taskId === sourceTask)).toBe(false)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

// Established public runtime seam: a real failed modeled propulsor, estimator-driven recovery
// and observed contact. This does not qualify hardware or identify a physical emergency envelope.
test('a declared front-transition failure route cancels failed wing support, observes hover and lands without retry', () => {
  const profile = declaredRecovery('front'), createSession = profile.createSession
  profile.createSession = () => {
    const session = createSession(), plant = session.createPlant()
    return { ...session, createPlant: () => ({ snapshot: () => plant.snapshot(), step(actuators, dtS, environment) {
      const failed = [...actuators]
      failed[4] = 0
      return plant.step(failed, dtS, environment)
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  console.log('VTOL_FAILED_PUSHER_RECOVERY', JSON.stringify({ status: report.status, fault: report.fault, mission: report.mission, finalPositionM: report.finalTruthPositionM, transitions: report.transitions }))
  expect(report.status).toBe('completed')
  expect(report.mission.reason).toBe('vtol-recovery-landed')
  expect(report.path.some(row => row.mission.taskId === 'recover-hover' && row.actuators.slice(0, 4).some(n => n > 0))).toBe(true)
  expect(report.trace.rows.filter(row => row.observation.transition?.outcome === 'confirmed').map(row => row.observation.transition!.mode)).toEqual(['hover', 'hover'])
  expect(report.path.some(row => row.mission.taskId === 'cruise-leg')).toBe(false)
  expect(report.transitions.filter(row => row.taskId === 'front')).toHaveLength(1)
  expect(report.path.filter(row => row.mission.taskId === 'recover-land').at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(Math.hypot(report.finalTruthPositionM[0], report.finalTruthPositionM[1])).toBeLessThan(0.3)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.authority.events.filter(event => event.to === 'autonomous')).toHaveLength(1)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

for (const [landingTimeoutMs, worstCaseMs, requiredWh] of [[20000, 141520, 47.17333333333333], [25000, 146520, 48.84], [35000, 156520, 52.17333333333333]] as const) test(`back-transition recovery retains the declared ${landingTimeoutMs} ms approach and landing budget`, () => {
  const profile = declaredRecovery('back'), back = profile.mission.tasks.find(task => task.id === 'back')!
  if (back.kind !== 'vtol-mode') throw new Error('Expected a VTOL mode task')
  back.timeoutMs = 15000
  const hover = profile.mission.tasks.find(task => task.id === 'recover-hover')!, land = profile.mission.tasks.find(task => task.id === 'recover-land')!
  if (hover.kind !== 'vtol-mode' || land.kind !== 'land') throw new Error('Expected recovery tasks')
  hover.timeoutMs = 45000; land.timeoutMs = landingTimeoutMs
  const report = runVehicleSimulation(profile, { seconds: 160 })
  console.log('VTOL_BACK_TIMEOUT_RECOVERY', JSON.stringify({ landingTimeoutMs, status: report.status, fault: report.fault, mission: report.mission, budget: report.budget, finalPositionM: report.finalTruthPositionM, transitions: report.transitions }))
  expect(report.budget.worstCaseMs).toBe(worstCaseMs)
  expect(report.budget.requiredWh).toBeCloseTo(requiredWh, 8)
  const landingStart = report.transitions.find(row => row.taskId === 'recover-land' && row.state === 'running')!.atMs
  if (landingTimeoutMs === 20000) {
    expect(report.status).toBe('blocked')
    expect(report.mission.reason).toBe('task-timeout')
    expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(false)
    expect(report.finalTruthPositionM[2]).toBeLessThan(-1)
    expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(report.board.expiresAtMs).toBeNull()
    expect(report.path.at(-1)!.atMs - landingStart).toBe(landingTimeoutMs)
    expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
    return
  }
  expect(report.status).toBe('completed')
  expect(report.path.at(-1)!.atMs - landingStart).toBeLessThan(landingTimeoutMs)
  expect(report.mission.reason).toBe('vtol-recovery-landed')
  expect(report.mission.recovery).toMatchObject({ failedTaskId: 'back', hoverTaskId: 'recover-hover', cause: 'timeout' })
  const original = report.path.find(row => row.mission.taskId === 'back' && row.mission.transition)!.mission.transition!
  const replacement = report.path.find(row => row.mission.taskId === 'recover-hover')!.mission.transition!
  expect(replacement.supersedesEventId).toBe(original.eventId)
  expect(replacement.issuedAtMs).toBe(original.expiresAtMs)
  expect(replacement.expiresAtMs - replacement.issuedAtMs).toBe(45000)
  expect(report.trace.rows.filter(row => row.observation.transition?.outcome === 'confirmed').map(row => row.observation.transition!.taskId)).toEqual(['initial-hover', 'front', 'recover-hover'])
  expect(report.transitions.filter(row => row.taskId === 'back')).toHaveLength(1)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(Math.hypot(report.finalTruthPositionM[0] - 180, report.finalTruthPositionM[1])).toBeLessThan(0.3)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.authority.events.filter(event => event.to === 'autonomous')).toHaveLength(1)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

for (const [sourceTask, atMs, northM] of [['initial-hover', 700, 0], ['front', 13000, 0], ['back', 30000, 180]] as const) test(`an operator abort during ${sourceTask} follows declared hover and observed contact`, () => {
  const profile = declaredRecovery(sourceTask)
  const report = runVehicleSimulation(profile, { seconds: 160, missionActions: [{ atMs, action: 'abort' }] })
  console.log('VTOL_PHASE_ABORT_LANDING', JSON.stringify({ sourceTask, status: report.status, fault: report.fault, mission: report.mission, finalPositionM: report.finalTruthPositionM, transitions: report.transitions }))
  expect(report.mission.state).toBe('aborted')
  expect(report.mission.reason).toBe('vtol-abort-landed')
  expect(report.mission.recovery).toMatchObject({ failedTaskId: sourceTask, cause: 'operator-abort', triggeredAtMs: atMs })
  expect(report.trace.rows.at(-1)!.observation.nowMs).toBeGreaterThan(atMs)
  expect(report.trace.rows.filter(row => row.observation.transition?.outcome === 'confirmed').map(row => row.observation.transition!.taskId)).toEqual(sourceTask === 'back' ? ['initial-hover', 'front', 'recover-hover'] : sourceTask === 'front' ? ['initial-hover', 'recover-hover'] : ['recover-hover'])
  expect(report.path.some(row => row.mission.state === 'completed')).toBe(false)
  if (sourceTask !== 'back') expect(report.path.some(row => row.mission.taskId === 'cruise-leg')).toBe(false)
  if (sourceTask !== 'initial-hover') expect(report.path.filter(row => row.atMs >= atMs && row.mission.taskId === 'recover-hover').some(row => row.actuators.slice(0, 4).some(n => n > 0))).toBe(true)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(Math.hypot(report.finalTruthPositionM[0] - northM, report.finalTruthPositionM[1])).toBeLessThan(0.3)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.authority.events.filter(event => event.to === 'autonomous')).toHaveLength(1)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

for (const [sourceTask, atMs, resumeAtMs, northM] of [['initial-hover', 700, 2000, 0], ['front', 13000, 40000, 0], ['back', 30000, 80000, 180]] as const) {
  for (const action of ['pause', 'recover'] as const) test(`declared ${sourceTask} ${action} qualifies hover before pausing for explicit resume`, () => {
    const profile = declaredRecovery(sourceTask)
    const report = runVehicleSimulation(profile, { seconds: 180, missionActions: [{ atMs, action }, { atMs: resumeAtMs, action: 'resume' }] })
    console.log('VTOL_PHASE_PAUSE_RECOVERY', JSON.stringify({ sourceTask, action, status: report.status, fault: report.fault, mission: report.mission, transitions: report.transitions }))
    expect(report.status).toBe('completed')
    expect(report.mission.reason).toBe('vtol-recovery-landed')
    expect(report.mission.recovery).toMatchObject({ failedTaskId: sourceTask, cause: `operator-${action}`, triggeredAtMs: atMs })
    const paused = report.path.filter(row => row.mission.state === 'paused')
    expect(paused.length).toBeGreaterThan(10)
    expect(paused.at(-1)!.atMs).toBe(resumeAtMs - 20)
    expect(paused.every(row => row.mission.taskId === 'recover-land' && row.mission.transition === null && row.mission.reason === 'vtol-recovery-hover-awaiting-resume')).toBe(true)
    if (sourceTask === 'initial-hover') expect(paused.every(row => row.measurement!.values.onSurface === true && row.actuators.every(n => n === 0))).toBe(true)
    else expect(paused.every(row => row.measurement!.values.onSurface === false && row.actuators.slice(0, 4).some(n => n > 0))).toBe(true)
    const held = paused[0]!.mission.targetM!
    expect(Math.max(...paused.map(row => Math.hypot(...row.truthPositionM.map((n, i) => n - held[i]!))))).toBeLessThan(1)
    const qualified = report.trace.rows.find(row => row.observation.transition?.taskId === 'recover-hover' && row.observation.transition.outcome === 'confirmed')!
    expect(qualified.observation.transition!.measurementCapturedAtMs).toBeGreaterThanOrEqual(atMs + (sourceTask === 'initial-hover' ? 200 : 500))
    if (sourceTask !== 'back') expect(report.path.some(row => row.mission.taskId === 'cruise-leg')).toBe(false)
    expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
    expect(report.finalTruthPositionM[2]).toBe(0)
    expect(Math.hypot(report.finalTruthPositionM[0] - northM, report.finalTruthPositionM[1])).toBeLessThan(0.3)
    expect(report.authority.events.filter(event => event.to === 'autonomous')).toHaveLength(1)
    expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
  })
}
