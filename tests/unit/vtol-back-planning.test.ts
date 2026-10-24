import { expect, test } from 'bun:test'
import type { VehicleControllerContext, VehicleVtolBackCaptureForecast } from '../../resources/functions/drone/vehicles/types'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { createVtolBackCaptureProfile } from '../../resources/functions/drone/vehicles/vtol/back-capture-profile'
import { createVtolTransitionProfile } from '../../resources/functions/drone/vehicles/vtol/transition-profile'

// Agreed public runtime seam: captures a real GNSS update between airflow capture
// and delivery. This checks retained navigation evidence, not planner feasibility or hardware.
test('delayed VTOL airflow retains the ground motion from its capture before a later GNSS correction', () => {
  const profile = createVtolBackCaptureProfile(), createSession = profile.createSession
  const inputs: VehicleControllerContext[] = []
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(context) { inputs.push(structuredClone(context)); return controller.step(context) } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 35 })
  const captured = new Map(inputs.map(context => [context.nowMs, context.estimate.localPosition]))
  const delivery = inputs.find(context => {
    const pose = context.measurementPose, current = context.estimate.localPosition
    const atCapture = pose && captured.get(pose.capturedAtMs)
    return pose && current && atCapture && current.capturedAtMs! > atCapture.capturedAtMs!
      && Math.hypot(...current.velocityMps.map((n, i) => n - atCapture.velocityMps[i]!)) > 0.01
  })
  expect(delivery, 'Actual raw GNSS must correct navigation after an airflow capture and before its delayed delivery').toBeDefined()
  const pose = delivery!.measurementPose!, atCapture = captured.get(pose.capturedAtMs)!
  expect(delivery!.measurement!.capturedAtMs).toBe(pose.capturedAtMs)
  expect(delivery!.nowMs - pose.capturedAtMs).toBe(60)
  expect(pose.positionCapturedAtMs).toBe(atCapture.capturedAtMs!)
  expect(pose.positionPredictedToMs).toBe(atCapture.predictedToMs)
  expect(pose.positionCapturedAtMs).toBeLessThan(delivery!.estimate.localPosition!.capturedAtMs!)
  expect(pose.reference).toBe(delivery!.measurement!.reference)
  // Fixed scalar observations make the original missing-capture failure diagnosable.
  console.log(JSON.stringify({ oracle: 'vtol-capture-motion', captureAtMs: pose.capturedAtMs, deliveredAtMs: delivery!.nowMs, captureGnssAtMs: atCapture.capturedAtMs, decisionGnssAtMs: delivery!.estimate.localPosition!.capturedAtMs, captureVelocityMps: atCapture.velocityMps, decisionVelocityMps: delivery!.estimate.localPosition!.velocityMps, retainedVelocity: Object.hasOwn(pose, 'velocityMps') }))
  expect([...pose.velocityMps!]).toEqual(atCapture.velocityMps)
  expect(Reflect.get(pose, 'covarianceBlocks')).toEqual(atCapture.covarianceBlocks)
  expect(report.physicalFlightEnabled).toBe(false)
  expect(report.boardOutputsInhibited).toBe(true)
})

// Public runtime seam: a far declared hover anchor needs a wing-borne approach,
// then real captured hover and contact within the original 45-second mode budget.
test('planned back capture approaches an explicit anchor before braking and retains its finite forecasts', () => {
  const profile = createVtolBackCaptureProfile(), createSession = profile.createSession
  profile.mission.id = 'vtol-bounded-back-capture-test'
  const back = profile.mission.tasks.find(task => task.id === 'back')!
  const land = profile.mission.tasks.find(task => task.id === 'land')!
  Object.assign(back, { anchorM: [330, 0, -15], approach: 'bounded-approach-v1' })
  Object.assign(land, { positionM: [330, 0, 0] })
  const forecasts: VehicleVtolBackCaptureForecast[] = []
  const backOutputs: { atMs: number, reason: string, outcome: string | null, sourceAtMs: number | null, captureNavigationAtMs: number | null }[] = []
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(context) {
      const output = controller.step(context), observation = output.backCapture
      if (observation) forecasts.push(structuredClone(observation))
      if (context.mission.taskId === 'back') backOutputs.push({ atMs: context.nowMs, reason: output.reason, outcome: output.transition?.outcome ?? null, sourceAtMs: output.transition?.measurementCapturedAtMs ?? null, captureNavigationAtMs: context.measurementPose?.positionCapturedAtMs ?? null })
      return output
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  console.log(JSON.stringify({ oracle: 'vtol-planned-capture-route', status: report.status, fault: report.fault, reason: report.mission.reason, lastAtMs: report.path.at(-1)!.atMs, lastPositionM: report.path.at(-1)!.positionM, backRequest: report.trace.rows.find(row => row.result.transition?.taskId === 'back')?.result.transition }))
  console.log(JSON.stringify({ oracle: 'vtol-back-capture-forecasts', forecasts: forecasts.map(item => ({ status: item.status, reason: item.reason, sourceCapturedAtMs: item.sourceCapturedAtMs, waitMs: item.waitMs, brakeAtMs: item.brakeAtMs, predictions: item.predictions.length })) }))
  const hoverAt = backOutputs.findIndex(row => row.reason === 'force-managed-hover')
  console.log(JSON.stringify({ oracle: 'vtol-back-confirmation-delivery', hoverAt: hoverAt < 0 ? null : backOutputs[hoverAt]!.atMs, aroundHover: hoverAt < 0 ? [] : backOutputs.slice(Math.max(0, hoverAt - 2), hoverAt + 3), confirmations: backOutputs.filter(row => row.outcome === 'confirmed') }))
  expect(report.status).toBe('completed')
  expect(report.fault).toBeNull()
  const request = report.trace.rows.find(row => row.result.transition?.taskId === 'back')!.result.transition!
  expect(request.positionM).toEqual([330, 0, -15])
  expect(request.expiresAtMs - request.issuedAtMs).toBeLessThanOrEqual(45000)
  expect(forecasts.length).toBeGreaterThan(0)
  expect(report.path.flatMap(row => row.backCapture ? [row.backCapture] : [])).toEqual(forecasts)
  expect(forecasts[0]).toMatchObject({ evidence: 'modeled-vtol-back-capture-forecast-v1', anchorM: [330, 0, -15], physicalFlightEnabled: false })
  expect(forecasts[0]!.predictions.length).toBeLessThanOrEqual(28)
  const selected = forecasts[0]!.predictions.filter(prediction => prediction.waitMs === forecasts[0]!.waitMs)
  expect(selected).toHaveLength(7)
  expect(selected.every(prediction => prediction.status === 'confirmed' && prediction.confirmedAtMs! <= request.expiresAtMs - 1500)).toBe(true)
  expect(selected.every(prediction => prediction.requiredWh! + 30 <= forecasts[0]!.remainingWhLowerBound!)).toBe(true)

  expect(report.path.some(row => row.mission.taskId === 'back' && row.actuators[4]! > 0.1)).toBe(true)
  expect(report.trace.rows.filter(row => row.observation.transition?.outcome === 'confirmed').map(row => row.observation.transition!.phase)).toEqual(['hover', 'cruise', 'hover'])
  expect(Math.hypot(report.finalTruthPositionM[0] - 330, report.finalTruthPositionM[1])).toBeLessThan(0.3)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.physicalFlightEnabled).toBe(false)
}, 60000)

// Public runtime seam: source-contract faults are checked after a forecast, not only at admission.
test.each([
  { name: 'changed capacity', change: { batteryCapacityWh: 99 }, reason: 'forecast-source-envelope-unqualified' },
  { name: 'regressed energy', change: { batteryEnergyUsedWh: 0 }, reason: 'forecast-source-envelope-unqualified' },
  { name: 'source power above the declared ceiling', change: { batterySourcePowerW: 1201 }, reason: 'forecast-source-envelope-unqualified' },
  { name: 'contradictory current and load', change: { batteryLoadPowerW: 0 }, reason: 'forecast-source-envelope-unqualified' },
  { name: 'latched supply cutoff', change: { batteryCutoff: true }, reason: 'forecast-source-cutoff' },
])('a capture invalidates a later $name observation without retrying', ({ change, reason }) => {
  const profile = createVtolBackCaptureProfile(), createSession = profile.createSession
  profile.mission.id = 'vtol-back-capture-battery-contract'
  Object.assign(profile.mission.tasks.find(task => task.id === 'back')!, { anchorM: [330, 0, -15], approach: 'bounded-approach-v1' })
  Object.assign(profile.mission.tasks.find(task => task.id === 'land')!, { positionM: [330, 0, 0] })
  let admittedSequence: number | null = null, injected = false
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(context) {
      const input = structuredClone(context)
      if (admittedSequence !== null && input.mission.taskId === 'back' && input.measurement!.sequence > admittedSequence) {
        Object.assign(input.measurement!.values, change)
        injected = true
      }
      const output = controller.step(input)
      if (output.backCapture?.status === 'predicted') admittedSequence = input.measurement!.sequence
      return output
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  const forecasts = report.path.flatMap(row => row.backCapture ? [row.backCapture] : [])
  expect(admittedSequence).not.toBeNull()
  expect(injected).toBe(true)
  expect(report.status).toBe('blocked')
  expect(report.fault).toBe('vtol-transition-aborted')
  expect(forecasts.map(row => row.status)).toEqual(['predicted', 'uncertain'])
  expect(forecasts.at(-1)!.reason).toBe(reason)
  expect(new Set(report.trace.rows.flatMap(row => row.result.transition?.taskId === 'back' ? [row.result.transition.eventId] : [])).size).toBe(1)
  expect(report.trace.rows.some(row => row.observation.transition?.taskId === 'back' && row.observation.transition.outcome === 'confirmed')).toBe(false)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
}, 60000)

// Public runtime seam: a previously accepted forecast cannot hide later unavailable motion.
test('a planned capture refuses lost capture motion after forecast admission without retrying', () => {
  const profile = createVtolBackCaptureProfile(), createSession = profile.createSession
  profile.mission.id = 'vtol-back-capture-motion-loss'
  Object.assign(profile.mission.tasks.find(task => task.id === 'back')!, { anchorM: [330, 0, -15], approach: 'bounded-approach-v1' })
  Object.assign(profile.mission.tasks.find(task => task.id === 'land')!, { positionM: [330, 0, 0] })
  let admitted = false, lost = false
  const observations: VehicleVtolBackCaptureForecast[] = []
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(context) {
      const input = structuredClone(context)
      if (admitted && input.mission.taskId === 'back') { Reflect.deleteProperty(input.measurementPose!, 'velocityMps'); lost = true }
      const output = controller.step(input)
      if (output.backCapture) { observations.push(structuredClone(output.backCapture)); admitted ||= output.backCapture.status === 'predicted' }
      return output
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  expect(admitted && lost).toBe(true)
  expect(report.status).toBe('blocked')
  expect(report.fault).toBe('vtol-transition-aborted')
  expect(observations.at(-1)).toMatchObject({ status: 'uncertain', reason: 'capture-motion-unqualified', physicalFlightEnabled: false })
  expect(report.path.flatMap(row => row.backCapture ? [row.backCapture] : [])).toEqual(observations)
  expect(new Set(report.trace.rows.flatMap(row => row.result.transition?.taskId === 'back' ? [row.result.transition.eventId] : [])).size).toBe(1)
  expect(report.trace.rows.some(row => row.observation.transition?.taskId === 'back' && row.observation.transition.outcome === 'confirmed')).toBe(false)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
}, 60000)

test.each([
  { name: 'non-PSD capture covariance', change(input: VehicleControllerContext) { input.measurementPose!.covarianceBlocks![0]!.positionVelocityM2S = 100 }, reason: 'capture-motion-unqualified' },
  { name: 'sparse capture covariance', change(input: VehicleControllerContext) { Reflect.deleteProperty(input.measurementPose!.covarianceBlocks!, '1') }, reason: 'capture-motion-unqualified' },
  { name: 'sparse retained velocity', change(input: VehicleControllerContext) { Reflect.deleteProperty(input.measurementPose!.velocityMps!, '1') }, reason: 'capture-motion-unqualified' },
  { name: 'expanded uncertainty below the model ceiling', change(input: VehicleControllerContext) { input.measurementPose!.covarianceBlocks![0]!.velocityM2S2 = 0.04 }, reason: 'forecast-uncertainty-expanded' },
  { name: 'shifted wind beyond the sampled uncertainty', change(input: VehicleControllerContext) { input.measurementPose!.velocityMps![1] += 0.4 }, reason: 'forecast-wind-changed' },
  { name: 'regressed navigation source', change(input: VehicleControllerContext) { input.measurementPose!.positionCapturedAtMs -= 100 }, reason: 'capture-motion-epoch-regressed', fault: 'capture-motion-epoch-regressed' },
  { name: 'wind inconsistent with the forecast', change(input: VehicleControllerContext) { input.measurementPose!.velocityMps![1] += 2.5 }, reason: 'forecast-wind-changed' },
  { name: 'uncertainty outside the declared model', change(input: VehicleControllerContext) { input.measurementPose!.covarianceBlocks![0]!.velocityM2S2 = 2 }, reason: 'forecast-uncertainty-expanded' },
])('an admitted capture refuses later $name', ({ change, reason, fault }) => {
  const profile = createVtolBackCaptureProfile(), createSession = profile.createSession
  profile.mission.id = 'vtol-back-capture-source-contract'
  Object.assign(profile.mission.tasks.find(task => task.id === 'back')!, { anchorM: [330, 0, -15], approach: 'bounded-approach-v1' })
  Object.assign(profile.mission.tasks.find(task => task.id === 'land')!, { positionM: [330, 0, 0] })
  let admitted = false, injected = false
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(context) {
      const input = structuredClone(context)
      if (admitted && input.mission.taskId === 'back') { change(input); injected = true }
      const output = controller.step(input)
      admitted ||= output.backCapture?.status === 'predicted'
      return output
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  const forecasts = report.path.flatMap(row => row.backCapture ? [row.backCapture] : [])
  expect(admitted && injected).toBe(true)
  expect(report.status).toBe('blocked')
  expect(report.fault).toBe(fault ?? 'vtol-transition-aborted')
  expect(forecasts.map(row => row.status)).toEqual(['predicted', 'uncertain'])
  expect(forecasts.at(-1)!.reason).toBe(reason)
  expect(forecasts.at(-1)!.monitor!.observedAtMs).toBeGreaterThan(forecasts[0]!.observedAtMs)
  expect(report.path.at(-1)!.atMs).toBeLessThan(forecasts[0]!.observedAtMs + 200)
  expect(report.trace.rows.some(row => row.observation.transition?.taskId === 'back' && row.observation.transition.outcome === 'confirmed')).toBe(false)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
}, 60000)

// Public controller/runtime seam: explicit null is malformed, not an opt-out from planning.
test('an explicit null back-capture policy cannot silently become unplanned braking', () => {
  const profile = createVtolBackCaptureProfile(), createSession = profile.createSession
  profile.mission.id = 'vtol-back-capture-null-policy'
  Object.assign(profile.mission.tasks.find(task => task.id === 'back')!, { anchorM: [330, 0, -15], approach: 'bounded-approach-v1' })
  Object.assign(profile.mission.tasks.find(task => task.id === 'land')!, { positionM: [330, 0, 0] })
  let injected = false
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(context) {
      const input = structuredClone(context)
      if (input.mission.transition?.taskId === 'back') { input.mission.transition.planning = null as never; injected = true }
      return controller.step(input)
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  expect(injected).toBe(true)
  expect(report.status).toBe('blocked')
  expect(report.fault).toBe('vtol-flight-request-unqualified')
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
}, 60000)

// Public runtime seam: a later source observation must still fund capture and the remaining DAG.
// The injected observation does not change plant truth or the runtime's independent battery checks.
test('an admitted capture aborts when a later battery observation cannot fund its reserve', () => {
  const profile = createVtolBackCaptureProfile(), createSession = profile.createSession
  profile.mission.id = 'vtol-back-capture-reserve-change'
  Object.assign(profile.mission.tasks.find(task => task.id === 'back')!, { anchorM: [330, 0, -15], approach: 'bounded-approach-v1' })
  Object.assign(profile.mission.tasks.find(task => task.id === 'land')!, { positionM: [330, 0, 0] })
  let admittedSequence: number | null = null, injected = false
  const observations: VehicleVtolBackCaptureForecast[] = []
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(context) {
      const input = structuredClone(context)
      if (admittedSequence !== null && input.mission.taskId === 'back' && input.measurement!.sequence > admittedSequence) {
        input.measurement!.values.batteryEnergyUsedWh = 80
        injected = true
      }
      const output = controller.step(input)
      if (output.backCapture) {
        observations.push(structuredClone(output.backCapture))
        if (output.backCapture.status === 'predicted') admittedSequence = input.measurement!.sequence
      }
      return output
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  console.log(JSON.stringify({ oracle: 'vtol-capture-reserve-change', admittedSequence, injected, status: report.status, fault: report.fault, observations: observations.map(row => ({ status: row.status, reason: row.reason, monitor: row.monitor })) }))
  expect(admittedSequence).not.toBeNull()
  expect(injected).toBe(true)
  expect(report.status).toBe('blocked')
  expect(report.fault).toBe('vtol-transition-aborted')
  expect(observations.at(-1)).toMatchObject({ status: 'uncertain', reason: 'forecast-reserve-exhausted', physicalFlightEnabled: false })
  expect(new Set(report.trace.rows.flatMap(row => row.result.transition?.taskId === 'back' ? [row.result.transition.eventId] : [])).size).toBe(1)
  expect(report.trace.rows.some(row => row.observation.transition?.taskId === 'back' && row.observation.transition.outcome === 'confirmed')).toBe(false)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
}, 60000)

// Retain the original constant-velocity prototype as an explicit unsupported plan.
// The new admitted-source regressions above use the declared fixture-IMU profile.
test('the original constant-velocity direct capture cannot qualify the conservative uncertainty model', () => {
  const profile = createVtolTransitionProfile({ electrical: true })
  profile.mission.tasks = profile.mission.tasks.filter(task => task.id !== 'cruise-leg')
  Object.assign(profile.mission.tasks.find(task => task.id === 'front')!, { next: 'back' })
  Object.assign(profile.mission.tasks.find(task => task.id === 'back')!, { anchorM: [330, 0, -15], approach: 'bounded-approach-v1' })
  Object.assign(profile.mission.tasks.find(task => task.id === 'land')!, { positionM: [330, 0, 0] })
  const result = runVehicleSimulation(profile, { seconds: 160 })
  const forecasts = result.path.flatMap(row => row.backCapture ? [row.backCapture] : [])
  expect(result.status).toBe('blocked')
  expect(forecasts).toHaveLength(1)
  expect(forecasts[0]!.status).toBe('limit')
  expect(result.trace.rows.some(row => row.observation.transition?.taskId === 'back' && row.observation.transition.outcome === 'confirmed')).toBe(false)
  expect(result.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(result.board.expiresAtMs).toBeNull()
}, 60000)
