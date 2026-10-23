import { expect, test } from 'bun:test'
import { createVtolPlant } from '../../resources/functions/drone/vehicles/vtol/plant'
import { allocateVtolLift } from '../../resources/functions/drone/vehicles/vtol/allocation'

// Public plant seam: checks vertical force integration without forward airspeed; it does not qualify a controller or physical aircraft.
test('lift-and-cruise rotors support the declared airframe without forward airspeed or an imposed position', () => {
  // Fictional 2.5 kg model: each of four rotors supplies 6.12915625 N in a level hover.
  const rotorsN: [number, number, number, number] = [6.12915625, 6.12915625, 6.12915625, 6.12915625]
  const supported = createVtolPlant({ positionM: [0, 0, -10], rotorsN })
  const environment = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }
  let state = supported.snapshot()
  // Channels are four rotor thrusts in N, normalized pusher throttle, then three surfaces in radians.
  for (let step = 0; step < 250; step++) state = supported.step([...rotorsN, 0, 0, 0, 0], 0.004, environment)
  expect(state.positionM[2]).toBeCloseTo(-10, 8)
  expect(state.velocityMps[2]).toBeCloseTo(0, 8)
  expect(state.accelerationMps2[2]).toBeCloseTo(0, 8)
  expect(state.details.airspeedMps).toBeCloseTo(0, 8)
  expect(state.onSurface).toBe(false)

  const unsupported = createVtolPlant({ positionM: [0, 0, -10] })
  const falling = unsupported.step([0, 0, 0, 0, 0, 0, 0, 0], 0.004, environment)
  expect(falling.accelerationMps2[2]).toBeCloseTo(9.80665, 8)
  expect(falling.velocityMps[2]).toBeGreaterThan(0)
  expect(falling.positionM[2]).toBeGreaterThan(-10)
})

test('rotor thrust spools up and decays after command release instead of changing instantaneously', () => {
  const plant = createVtolPlant({ positionM: [0, 0, -10] })
  const spooling = plant.step([12, 12, 12, 12, 0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(spooling.accelerationMps2[2]).toBeGreaterThan(8)
  expect(spooling.accelerationMps2[2]).toBeLessThan(9.80665)
  const released = plant.step([0, 0, 0, 0, 0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(released.accelerationMps2[2]).toBeGreaterThan(8)
  expect(released.accelerationMps2[2]).toBeLessThan(9.80665)
  expect(released.details.rotorThrustN).toBeGreaterThan(0)
  expect(released.details.rotorThrustN).toBeLessThan(spooling.details.rotorThrustN as number)
})

test('independent lift rotors generate body moments without forward airspeed', () => {
  // Rotor order: front-left, front-right, rear-right, rear-left in BODY_FRD.
  const oneRotor = createVtolPlant({ positionM: [0, 0, -10] })
  const turning = oneRotor.step([12, 0, 0, 0, 0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(turning.angularRateRadS.every(n => n > 0)).toBe(true)
  expect(turning.quaternionWxyz.slice(1).every(n => n > 0)).toBe(true)
  const frontPair = createVtolPlant({ positionM: [0, 0, -10] })
  const pitching = frontPair.step([12, 12, 0, 0, 0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(pitching.angularRateRadS[0]).toBeCloseTo(0, 10)
  expect(pitching.angularRateRadS[1]).toBeGreaterThan(0)
  expect(pitching.angularRateRadS[2]).toBeCloseTo(0, 10)
})

test('wing lift and the independent pusher act on the same body using relative airflow', () => {
  const still = createVtolPlant({ positionM: [0, 0, -20], velocityMps: [10, 0, 0] })
  const glide = still.step([0, 0, 0, 0, 0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  // At 10 m/s the declared trainer wing supplies 12.25 N of lift and 2.14375 N of drag.
  expect(glide.accelerationMps2[2]).toBeCloseTo(4.90665, 8)
  expect(glide.accelerationMps2[0]).toBeCloseTo(-0.8575, 8)
  const powered = createVtolPlant({ positionM: [0, 0, -20], velocityMps: [10, 0, 0], pusherThrustN: 7 })
  const thrust = powered.step([0, 0, 0, 0, 0.5, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(thrust.accelerationMps2[0]).toBeCloseTo(1.9425, 8)
  const windy = createVtolPlant({ positionM: [0, 0, -20], velocityMps: [10, 0, 0] })
  const headwind = windy.step([0, 0, 0, 0, 0, 0, 0, 0], 0.004, { windMps: [-5, 0, 0], currentMps: [0, 0, 0] })
  expect(headwind.accelerationMps2[2]).toBeLessThan(glide.accelerationMps2[2])
  expect(headwind.details.airspeedMps).toBeGreaterThan(14.9)
  expect(headwind.details.airspeedMps).toBeLessThan(15.1)
})

test('aerodynamic surfaces gain moment authority with airflow while rotor controls remain independent', () => {
  const resting = createVtolPlant({ positionM: [0, 0, -20] })
  const noAir = resting.step([0, 0, 0, 0, 0, 0.4, 0.4, 0.4], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(noAir.angularRateRadS).toEqual([0, 0, 0])
  const moving = createVtolPlant({ positionM: [0, 0, -20], velocityMps: [10, 0, 0] })
  const controlled = moving.step([0, 0, 0, 0, 0, 0.4, 0.4, 0.4], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  // Independently worked first-step surface moments: 5.6448, 5.22144 and 3.7632 Nm.
  expect(controlled.angularRateRadS[0]).toBeCloseTo(0.075264, 8)
  expect(controlled.angularRateRadS[1]).toBeCloseTo(0.0522144, 8)
  expect(controlled.angularRateRadS[2]).toBeCloseTo(0.025088, 8)
})

test('body-relative airflow and forces rotate consistently into the fixed NED frame', () => {
  const eastFacing = createVtolPlant({ positionM: [0, 0, -20], velocityMps: [0, 10, 0], quaternionWxyz: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], pusherThrustN: 7 })
  const east = eastFacing.step([0, 0, 0, 0, 0.5, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(east.accelerationMps2[0]).toBeCloseTo(0, 8)
  expect(east.accelerationMps2[1]).toBeCloseTo(1.9425, 8)
  expect(east.accelerationMps2[2]).toBeCloseTo(4.90665, 8)
  expect(east.details.betaRad).toBeCloseTo(0, 8)
})

test('malformed numeric packets are refused before changing the owned body or wind', () => {
  const plant = createVtolPlant({ positionM: [0, 0, -20] })
  const before = plant.snapshot()
  const sparse: number[] = []
  sparse.length = 8
  sparse.fill(0, 1)
  expect(() => plant.step(sparse, 0.004, { windMps: [-2, 0, 0], currentMps: [0, 0, 0] })).toThrow()
  expect(plant.snapshot()).toEqual(before)
  expect(() => createVtolPlant({ quaternionWxyz: [1, 0, 0, 0, 7] as never })).toThrow()
  expect(() => plant.step([13, 0, 0, 0, 0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })).toThrow()
  expect(plant.snapshot()).toEqual(before)
})

test('explicit null initial numeric fields cannot become a default vehicle state', () => {
  for (const field of ['positionM', 'velocityMps', 'quaternionWxyz', 'rotorsN', 'pusherThrustN']) {
    expect(() => createVtolPlant({ [field]: null } as never)).toThrow()
  }
  expect(createVtolPlant().snapshot().positionM).toEqual([0, 0, 0])
})

test('the independent pusher spools up and retains decaying thrust after release', () => {
  const plant = createVtolPlant({ positionM: [0, 0, -20] })
  const spooling = plant.step([0, 0, 0, 0, 1, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(spooling.accelerationMps2[0]).toBeGreaterThan(0)
  expect(spooling.accelerationMps2[0]).toBeLessThan(1)
  expect(spooling.details.pusherThrustN).toBeGreaterThan(0)
  expect(spooling.details.pusherThrustN).toBeLessThan(14)
  const released = plant.step([0, 0, 0, 0, 0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(released.details.pusherThrustN).toBeGreaterThan(0)
  expect(released.details.pusherThrustN).toBeLessThan(spooling.details.pusherThrustN as number)
})

test('a divergent integration leaves the retained body intact and the next ordinary step usable', () => {
  // Public step/snapshot catches rejected integration poisoning; it does not qualify a flight controller or recovery policy.
  for (const windMps of [[1000000, 1000000, 0], [0, 0, 1000000]] as [number, number, number][]) {
    const initial = { positionM: [0, 0, -20] as [number, number, number], velocityMps: [10, 0, 0] as [number, number, number], rotorsN: [1, 2, 3, 4] as [number, number, number, number], pusherThrustN: 7 }
    const plant = createVtolPlant(initial), reference = createVtolPlant(initial)
    const before = plant.snapshot()
    const command = [12, 12, 12, 12, 1, 0, 0, 0]
    expect(() => plant.step(command, 0.004, { windMps, currentMps: [0, 0, 0] })).toThrow()
    expect(plant.snapshot()).toEqual(before)
    const environment = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }
    expect(plant.step(command, 0.004, environment)).toEqual(reference.step(command, 0.004, environment))
  }
})

test('VTOL lift allocation produces the declared BODY_FRD wrench in front-left rotor order', () => {
  // Independent inverse: [10, 6, 4, 4] N produces 24 N and [1.6, 3.2, 0.08] Nm.
  const result = allocateVtolLift({ thrustN: 24, torqueNm: [1.6, 3.2, 0.08] })
  expect(result.rotorsN).toEqual([10, 6, 4, 4])
  expect(result.achieved.thrustN).toBe(24)
  expect(result.achieved.torqueNm[0]).toBeCloseTo(1.6, 10)
  expect(result.achieved.torqueNm[1]).toBeCloseTo(3.2, 10)
  expect(result.achieved.torqueNm[2]).toBeCloseTo(0.08, 10)
  expect(result.limited).toBe(false)
})

test('saturated lift allocation preserves collective before roll and pitch and sacrifices yaw first', () => {
  const result = allocateVtolLift({ thrustN: 44, torqueNm: [3.2, 0, 0.08] })
  expect(result.rotorsN).toEqual([12, 10, 10, 12])
  expect(result.achieved.thrustN).toBe(44)
  expect(result.achieved.torqueNm).toEqual([1.6, 0, 0])
  expect(result.limited).toBe(true)
})

test('lift allocation refuses malformed and nonfinite wrench packets instead of returning invalid rotor commands', () => {
  const sparse: number[] = []
  sparse.length = 3
  sparse.fill(0, 1)
  for (const wrench of [{ thrustN: Number.NaN, torqueNm: [0, 0, 0] }, { thrustN: 24, torqueNm: sparse }, { thrustN: 24, torqueNm: [0, 0, Infinity] }, { thrustN: 24, torqueNm: [0, 0, 0, 1] }, { thrustN: 24, torqueNm: null }]) {
    expect(() => allocateVtolLift(wrench as never)).toThrow()
  }
})

test('inherited slots and custom iterators cannot disguise malformed lift torque packets', () => {
  const sparse: number[] = []
  sparse.length = 3
  sparse.fill(0, 1)
  Object.setPrototypeOf(sparse, Object.assign(Object.create(Array.prototype), { 0: 0 }))
  let iteratorCalls = 0
  const rewritten = [NaN, 0, 0]
  Object.defineProperty(rewritten, Symbol.iterator, { value: function* () { iteratorCalls++; yield 0; yield 0; yield 0 } })
  for (const torqueNm of [sparse, rewritten]) expect(() => allocateVtolLift({ thrustN: 24, torqueNm } as never)).toThrow()
  expect(iteratorCalls).toBe(0)
})


test('declared skid friction stops residual ground motion gradually without braking an airborne body', () => {
  const environment = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }, neutral = [0, 0, 0, 0, 0, 0, 0, 0]
  const ground = createVtolPlant({ velocityMps: [0.24, 0, 0] })
  const first = ground.step(neutral, 0.004, environment)
  expect(first.onSurface).toBe(true)
  expect(first.velocityMps[0]).toBeGreaterThan(0.20)
  expect(first.velocityMps[0]).toBeLessThan(0.23)
  let stopped = first
  for (let step = 1; step < 250; step++) stopped = ground.step(neutral, 0.004, environment)
  expect(Math.hypot(...stopped.velocityMps)).toBeLessThan(1e-8)
  expect(stopped.positionM[0]).toBeGreaterThan(0)
  expect(stopped.positionM[0]).toBeLessThan(0.02)
  const air = createVtolPlant({ positionM: [0, 0, -1], velocityMps: [0.24, 0, 0] })
  const flying = air.step(neutral, 0.004, environment)
  expect(flying.onSurface).toBe(false)
  expect(flying.velocityMps[0]).toBeGreaterThan(0.239)
  const liftSupported = createVtolPlant({ velocityMps: [0.24, 0, 0], rotorsN: [6.12915625, 6.12915625, 6.12915625, 6.12915625] })
  const unloaded = liftSupported.step([6.12915625, 6.12915625, 6.12915625, 6.12915625, 0, 0, 0, 0], 0.004, environment)
  expect(unloaded.velocityMps[0]).toBeGreaterThan(0.239)
  expect(unloaded.positionM[2]).toBeLessThan(0)
})
