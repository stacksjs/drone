import { expect, test } from 'bun:test'
import { allocateSubseaWrench, subseaWrenchFromThrusters } from '../../resources/functions/drone/vehicles/subsea/allocation'

test('eight thrusters independently realize all six body wrench axes and preserve direction under saturation', () => {
  const force = allocateSubseaWrench({ forceN: [4, 0, 0], torqueNm: [0, 0, 0] })
  force.thrustersN.slice(0, 4).forEach(n => expect(n).toBeCloseTo(Math.SQRT2, 12))
  expect(force.thrustersN.slice(4)).toEqual([0, 0, 0, 0])
  const cases = [
    { forceN: [0, 4, 0], torqueNm: [0, 0, 0] },
    { forceN: [0, 0, 4], torqueNm: [0, 0, 0] },
    { forceN: [0, 0, 0], torqueNm: [1, 0, 0] },
    { forceN: [0, 0, 0], torqueNm: [0, 1, 0] },
    { forceN: [0, 0, 0], torqueNm: [0, 0, 1] },
  ]
  for (const wrench of cases) {
    const result = allocateSubseaWrench(wrench as Parameters<typeof allocateSubseaWrench>[0])
    expect(result.scale).toBe(1)
    result.achievedWrench.forceN.forEach((n, i) => expect(n).toBeCloseTo(wrench.forceN[i]!, 10))
    result.achievedWrench.torqueNm.forEach((n, i) => expect(n).toBeCloseTo(wrench.torqueNm[i]!, 10))
  }
  const saturated = allocateSubseaWrench({ forceN: [120, 60, 40], torqueNm: [5, 3, 20] })
  expect(Math.max(...saturated.thrustersN.map(Math.abs))).toBeCloseTo(15, 10)
  expect(saturated.scale).toBeGreaterThan(0); expect(saturated.scale).toBeLessThan(1)
  expect(saturated.achievedWrench.forceN[0]).toBeCloseTo(120 * saturated.scale, 10)
  expect(saturated.achievedWrench.torqueNm[2]).toBeCloseTo(20 * saturated.scale, 10)
  const isolated = subseaWrenchFromThrusters([0, 0, 0, 0, 1, 0, 0, 0])
  expect(isolated).toEqual({ forceN: [0, 0, 1], torqueNm: [0.2, -0.3, 0] })
  expect(() => allocateSubseaWrench({ forceN: [NaN, 0, 0], torqueNm: [0, 0, 0] })).toThrow()
  expect(() => subseaWrenchFromThrusters([16, 0, 0, 0, 0, 0, 0, 0])).toThrow()
})

import { createSubseaPlant } from '../../resources/functions/drone/vehicles/subsea/plant'
const calm = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }
test('submerged forces include added mass, buoyancy, current drag, six-axis moments and elastic tether', () => {
  const neutral = createSubseaPlant({ positionM: [0, 0, 2] }).step(Array(8).fill(0), 0.004, calm)
  // 2 N excess buoyancy / (20 kg body + 5 kg added mass).
  expect(neutral.accelerationMps2[2]).toBeCloseTo(-0.08, 10)
  expect(neutral.velocityMps[2]).toBeCloseTo(-0.00032, 10)
  const force = allocateSubseaWrench({ forceN: [25, 0, 0], torqueNm: [0, 0, 0] }).thrustersN
  const forward = createSubseaPlant({ positionM: [0, 0, 2] }).step(force, 0.004, calm)
  expect(forward.accelerationMps2[0]).toBeCloseTo(1, 10)
  expect(forward.positionM[0]).toBeCloseTo(0.000016, 10)
  const drift = createSubseaPlant({ positionM: [0, 0, 2] }).step(Array(8).fill(0), 0.004, { ...calm, currentMps: [0.2, 0, 0] })
  // 8*.2 + 12*.2^2 N current-relative resistance.
  expect(drift.accelerationMps2[0]).toBeCloseTo(0.0832, 10)
  for (const axis of [0, 1, 2]) {
    const torque: [number, number, number] = [0, 0, 0]; torque[axis] = 1
    const rotated = createSubseaPlant({ positionM: [0, 0, 2] }).step(allocateSubseaWrench({ forceN: [0, 0, 0], torqueNm: torque }).thrustersN, 0.004, calm)
    const expectedRate = [1 / 1.2, 1 / 1.5, 1 / 1.8][axis]! * 0.004
    expect(rotated.angularRateRadS[axis]).toBeCloseTo(expectedRate, 10)
    expect(Math.abs(rotated.quaternionWxyz[axis + 1]!)).toBeGreaterThan(0)
  }
  const tethered = createSubseaPlant({ positionM: [0, 0, 9] }).step(Array(8).fill(0), 0.004, calm)
  expect(tethered.details.tetherTensionN).toBeCloseTo(30, 10)
  expect(tethered.accelerationMps2[2]).toBeCloseTo(-1.28, 10)
  const plant = createSubseaPlant(); const copy = plant.snapshot(); copy.positionM[0] = 100
  expect(plant.snapshot().positionM).toEqual([0, 0, 0])
  expect(plant.step(Array(8).fill(0), 0.004, calm).positionM[2]).toBe(0)
  expect(() => plant.step(Array(8).fill(0), 0.021, calm)).toThrow()
  expect(() => plant.step(Array(8).fill(NaN), 0.004, calm)).toThrow()
})

import { createSubseaController } from '../../resources/functions/drone/vehicles/subsea/controller'
import { subseaContext } from '../fixtures/subsea/context'
test('estimated depth hold offsets buoyancy, tracks six-axis pose, and holds an underwater pause', () => {
  const c = subseaContext(), controller = createSubseaController(), hold = controller.step(c)
  expect(hold.inhibited).toBe(false)
  const wrench = subseaWrenchFromThrusters(hold.actuators)
  expect(wrench.forceN[2]).toBeCloseTo(2, 10)
  expect(wrench.forceN.slice(0, 2)).toEqual([0, 0])
  c.mission.state = 'paused'; c.mission.targetM = [0, 0, 2.5]
  expect(subseaWrenchFromThrusters(controller.step(c).actuators).forceN[2]).toBeGreaterThan(2)
  const tilted = subseaContext()
  tilted.estimate.attitude!.quaternionWxyz = [Math.cos(0.1), Math.sin(0.1), 0, 0]
  tilted.estimate.attitude!.eulerRad = [0.2, 0, 0]
  expect(subseaWrenchFromThrusters(createSubseaController().step(tilted).actuators).torqueNm[0]).toBeLessThan(0)
  const east = subseaContext(); east.mission.targetM = [0, 1, 2]
  expect(subseaWrenchFromThrusters(createSubseaController().step(east).actuators).forceN[1]).toBeGreaterThan(0)
  expect(createSubseaController().step({ ...subseaContext(), enabled: false }).actuators).toEqual(Array(8).fill(0))
  const ended = subseaContext(); ended.mission.state = 'completed'; ended.mission.targetM = null
  expect(createSubseaController().step(ended).actuators).toEqual(Array(8).fill(0))
})

test('subsea controller latches sensor, tether, leak, emergency, depth, speed and replay losses', () => {
  for (const fault of ['leak', 'tether', 'link', 'emergency', 'depth', 'speed', 'stale', 'replay', 'reference', 'clock', 'datum', 'missing', 'malformed'] as const) {
    const controller = createSubseaController(); expect(controller.step(subseaContext()).inhibited).toBe(false)
    const c = subseaContext(1020)
    if (fault === 'leak') c.measurement!.values.leak = true
    if (fault === 'tether') c.measurement!.values.tetherTensionN = 40
    if (fault === 'link') c.measurement!.values.linkConnected = false
    if (fault === 'emergency') c.measurement!.values.emergency = true
    if (fault === 'depth') c.estimate.localPosition!.positionM[2] = 8.01
    if (fault === 'speed') c.estimate.localPosition!.velocityMps[0] = 1.21
    if (fault === 'stale') c.measurement!.capturedAtMs = 100
    if (fault === 'replay') c.measurement!.sequence = 1
    if (fault === 'reference') c.measurement!.reference = 'other'
    if (fault === 'clock') c.nowMs = 1200
    if (fault === 'datum') c.estimate.localPosition!.altitudeDatum = 'WGS84_ELLIPSOID'
    if (fault === 'missing') c.measurement = null
    if (fault === 'malformed') c.estimate.attitude!.quaternionWxyz[0] = NaN
    expect(controller.step(c).actuators).toEqual(Array(8).fill(0))
    expect(controller.step(subseaContext(1040)).inhibited).toBe(true)
  }
})

test('subsea initial orientation rejects malformed quaternion dimensions and hydrodynamic restoring opposes tilt', () => {
  expect(() => createSubseaPlant({ quaternionWxyz: [1, 0, 0, 0, 1] as unknown as [number, number, number, number] })).toThrow()
  const rolled = createSubseaPlant({ positionM: [0, 0, 2], quaternionWxyz: [Math.cos(0.1), Math.sin(0.1), 0, 0] }).step(Array(8).fill(0), 0.004, calm)
  expect(rolled.angularRateRadS[0]).toBeLessThan(0)
  expect(rolled.angularRateRadS.slice(1)).toEqual([0, 0])
})

import { renderSubseaMeasurement } from '../../resources/functions/drone/vehicles/subsea/sensors'
test('closed-loop estimated-pose fixture converges in three dimensions and holds a paused target against current', () => {
  // This seam supplies ideal estimated pose. The separate shared-runtime tests exercise owned navigation.
  const plant = createSubseaPlant({ positionM: [0, 0, 2] }), controller = createSubseaController()
  const reference = subseaContext().measurement!.reference
  const queue = [renderSubseaMeasurement(plant.snapshot(), 940, reference, 1), renderSubseaMeasurement(plant.snapshot(), 960, reference, 2), renderSubseaMeasurement(plant.snapshot(), 980, reference, 3)]
  let measurement = queue.shift()!, sequence = 3, fault = '', maxDepth = 0
  for (let atMs = 1000; atMs <= 25000; atMs += 4) {
    const state = plant.snapshot()
    if (atMs % 20 === 0) queue.push(renderSubseaMeasurement(state, atMs, reference, ++sequence))
    while (queue[0] && queue[0].receivedAtMs <= atMs) measurement = queue.shift()!
    const c = subseaContext(atMs)
    c.measurement = measurement
    c.estimate.localPosition!.positionM = [...state.positionM]
    c.estimate.localPosition!.velocityMps = [...state.velocityMps]
    c.estimate.attitude!.quaternionWxyz = [...state.quaternionWxyz]
    c.mission.targetM = [1, 1, 3]; c.mission.state = atMs >= 10000 ? 'paused' : 'running'
    const output = controller.step(c)
    if (output.inhibited) { fault = output.reason; break }
    const next = plant.step(output.actuators, 0.004, { ...calm, currentMps: [0.08, 0.1, 0] })
    maxDepth = Math.max(maxDepth, next.positionM[2])
  }
  expect(fault).toBe('')
  const final = plant.snapshot()
  expect(Math.hypot(final.positionM[0] - 1, final.positionM[1] - 1, final.positionM[2] - 3)).toBeLessThan(0.08)
  expect(Math.hypot(...final.velocityMps)).toBeLessThan(0.03)
  expect(maxDepth).toBeLessThan(3.1)
})

test('valid leak observations latch during authority inhibition and a surface pause stays neutral', () => {
  const controller = createSubseaController(), leak = subseaContext()
  leak.enabled = false; leak.measurement!.values.leak = true
  expect(controller.step(leak).actuators).toEqual(Array(8).fill(0))
  expect(controller.step(subseaContext(1020)).inhibited).toBe(true)
  const surfaced = subseaContext()
  surfaced.estimate.localPosition!.positionM[2] = 0; surfaced.mission.targetM = [0, 0, 0]; surfaced.mission.state = 'paused'
  surfaced.measurement!.values.pressurePa = 101325; surfaced.measurement!.values.onSurface = true
  expect(createSubseaController().step(surfaced).actuators).toEqual(Array(8).fill(0))
})

import { multiplyQuaternion, quaternionEuler } from '../../resources/functions/drone/estimation/frames'
test('six-axis estimated-pose control recovers roll, pitch and yaw while holding underwater position', () => {
  const q = multiplyQuaternion(multiplyQuaternion([Math.cos(0.15), 0, 0, Math.sin(0.15)], [Math.cos(-0.075), 0, Math.sin(-0.075), 0]), [Math.cos(0.1), Math.sin(0.1), 0, 0])
  const plant = createSubseaPlant({ positionM: [0, 0, 2], quaternionWxyz: q }), controller = createSubseaController(), reference = subseaContext().measurement!.reference
  let fault = '', sequence = 0
  const queue = [renderSubseaMeasurement(plant.snapshot(), 940, reference, ++sequence)]
  let measurement = queue.shift()!
  for (let atMs = 1000; atMs <= 9000; atMs += 4) {
    const state = plant.snapshot()
    if (atMs % 20 === 0) queue.push(renderSubseaMeasurement(state, atMs, reference, ++sequence))
    while (queue[0] && queue[0].receivedAtMs <= atMs) measurement = queue.shift()!
    const c = subseaContext(atMs); c.measurement = measurement
    c.estimate.localPosition!.positionM = [...state.positionM]; c.estimate.localPosition!.velocityMps = [...state.velocityMps]
    c.estimate.attitude!.quaternionWxyz = [...state.quaternionWxyz]; c.estimate.attitude!.eulerRad = quaternionEuler(state.quaternionWxyz)
    const output = controller.step(c)
    if (output.inhibited) { fault = output.reason; break }
    plant.step(output.actuators, 0.004, calm)
  }
  expect(fault).toBe('')
  const final = plant.snapshot()
  expect(Math.hypot(...quaternionEuler(final.quaternionWxyz))).toBeLessThan(0.001)
  expect(Math.hypot(...final.angularRateRadS)).toBeLessThan(0.001)
  expect(Math.hypot(final.positionM[0], final.positionM[1], final.positionM[2] - 2)).toBeLessThan(0.03)
})
