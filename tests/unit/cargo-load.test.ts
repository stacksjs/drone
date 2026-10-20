import { expect, test } from 'bun:test'
import { simulateMultirotor } from '../../resources/functions/drone/controls/simulation'

// Independent oracle: integer units of 2^-1074, with explicit nearest/ties-to-even rounding.
// It imports neither allocation/model code nor the private cargo evaluator's endpoint predicate.
function binary64Units(value: number): bigint {
  if (!Number.isFinite(value)) throw new TypeError('finite binary64 fixture required')
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value, false)
  const bits = view.getBigUint64(0, false)
  const exponent = Number((bits >> 52n) & 0x7FFn)
  const fraction = bits & ((1n << 52n) - 1n)
  const significand = exponent === 0 ? fraction : (1n << 52n) | fraction
  const units = significand << BigInt(exponent === 0 ? 0 : exponent - 1)
  return (bits >> 63n) === 0n ? units : -units
}
function roundedBinary64Units(exact: bigint): bigint {
  const negative = exact < 0n
  const magnitude = negative ? -exact : exact
  const shift = Math.max(0, magnitude.toString(2).length - 53)
  if (shift === 0) return exact
  const shiftBits = BigInt(shift)
  let retained = magnitude >> shiftBits
  const discarded = magnitude - (retained << shiftBits)
  const half = 1n << BigInt(shift - 1)
  if (discarded > half || (discarded === half && (retained & 1n) === 1n)) retained++
  const rounded = retained << shiftBits
  return negative ? -rounded : rounded
}
function independentCargoStep(previous: number, next: number): boolean {
  if (![previous, next].every(n => Number.isFinite(n) && n >= 0 && n <= 10)) return false
  const a = binary64Units(previous), b = binary64Units(next)
  const h = roundedBinary64Units(40n * binary64Units(0.02))
  return b >= roundedBinary64Units(a - h) && b <= roundedBinary64Units(a + h)
}
function numberFromBits(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, bits, false)
  return view.getFloat64(0, false)
}

test('cargo command slew oracle admits rounded endpoints and rejects adjacent or material violations', () => {
  expect(binary64Units(0.02)).toBe(5764607523034235n << 1016n)
  expect(roundedBinary64Units(40n * binary64Units(0.02))).toBe(3602879701896397n << 1022n)
  expect(independentCargoStep(0, 0.8)).toBe(true)
  expect(independentCargoStep(0, 1)).toBe(false)
  expect(1 / 0.02).toBeGreaterThan(40 + 2 ** -44)
  expect(independentCargoStep(10, 10)).toBe(true)
  expect(independentCargoStep(1, 0)).toBe(false)

  // Hand-worked represented 1.6 + 0.8 endpoint and its immediately adjacent outside value.
  const upPrevious = numberFromBits(0x3FF999999999999An)
  const upEndpoint = numberFromBits(0x4003333333333334n)
  const upOutside = numberFromBits(0x4003333333333335n)
  expect(independentCargoStep(upPrevious, upEndpoint)).toBe(true)
  expect(independentCargoStep(upPrevious, upOutside)).toBe(false)
  expect(Math.abs(upOutside - upPrevious) / 0.02).toBeLessThanOrEqual(40 + 2 ** -44)

  // The downward endpoint differs by one representation step; a uniform epsilon alone misses it.
  const downEndpoint = numberFromBits(0x3FF999999999999Bn)
  const downOutside = numberFromBits(0x3FF999999999999An)
  expect(independentCargoStep(upEndpoint, downEndpoint)).toBe(true)
  expect(independentCargoStep(upEndpoint, downOutside)).toBe(false)
  expect(Math.abs(downOutside - upEndpoint) / 0.02).toBeLessThanOrEqual(40 + 2 ** -44)

  const one = 1n << 1074n, halfUlp = 1n << 1021n
  expect(roundedBinary64Units(one + halfUlp)).toBe(one)
  expect(roundedBinary64Units(one + 3n * halfUlp)).toBe(one + (1n << 1023n))
  expect(roundedBinary64Units(-one - halfUlp)).toBe(-one)
  expect(roundedBinary64Units(-one - 3n * halfUlp)).toBe(-one - (1n << 1023n))
  expect(roundedBinary64Units(0n)).toBe(0n)
  expect(binary64Units(0)).toBe(0n)
  expect(binary64Units(-0)).toBe(0n)
  expect(binary64Units(Number.MIN_VALUE)).toBe(1n)
  expect(binary64Units(-Number.MIN_VALUE)).toBe(-1n)
  expect(roundedBinary64Units(1n)).toBe(1n)
  expect(roundedBinary64Units(-1n)).toBe(-1n)
  expect(independentCargoStep(-0, Number.MIN_VALUE)).toBe(true)
  expect(independentCargoStep(0, -Number.MIN_VALUE)).toBe(false)
  expect(independentCargoStep(-Number.MIN_VALUE, 0)).toBe(false)
  expect(independentCargoStep(10, numberFromBits(0x4024000000000001n))).toBe(false)
  expect(independentCargoStep(NaN, 0)).toBe(false)
  expect(independentCargoStep(0, Infinity)).toBe(false)
})

// Existing public simulator seam. One real owned world, not a mocked or parallel cargo loop.
// This first tracer characterizes a carried mass. It proves no delivery, release mechanism or custody.
test('centered carried cargo retains real physical and raw-sensor authority evidence in the existing loop', () => {
  const result = simulateMultirotor({ cargoLoadCase: 'centered-carried' })

  // The current implementation lacks this field. Stop here for the first capability RED.
  expect(Object.hasOwn(result, 'cargoLoadEvidence')).toBe(true)
  expect(Object.keys(result)).toEqual(['evidence', 'scenario', 'seconds', 'physicsStepMs', 'additionalSensorDelayMs', 'physicalFlightEnabled', 'boardOutputsInhibited', 'headingAlignment', 'gravityCorrection', 'supportWarmupMs', 'model', 'response', 'metrics', 'state', 'estimate', 'control', 'trace', 'authority', 'cargoLoadEvidence'])
  const evidence = result.cargoLoadEvidence
  expect(Object.keys(evidence)).toEqual(['version', 'scenario', 'model', 'counts', 'separation', 'physical', 'policy', 'evaluation', 'final'])
  expect(evidence.version).toBe(1)
  expect(evidence.scenario).toBe('centered-carried')
  expect(result.scenario).toBe('hover')
  expect(result.seconds).toBe(20)
  expect(result.physicsStepMs).toBe(4)
  expect(result.additionalSensorDelayMs).toBe(0)
  expect(result.physicalFlightEnabled).toBe(false)
  expect(result.boardOutputsInhibited).toBe(true)
  expect(result.trace.length).toBe(101)
  expect(evidence.model).toEqual({
    baseMassKg: 1.5, baseInertia: [0.03, 0.03, 0.05], gravityMps2: 9.80665,
    loadMassKg: 0.1, loadForwardM: 0, dtMs: 4, policyMs: 20, durationMs: 20000,
    supportWarmupMs: 600, separationAtMs: null, targetM: [0, 0, -1],
    massAwareController: false, inertialPositionFusion: false,
    separationModel: 'prescribed-instantaneous-zero-ejection-point-mass',
    energyModel: 'not-qualified', contactModel: 'structural-point-plane-approximation',
  })
  expect(evidence.counts).toEqual({ worldSnapshots: 5001, heldSupportRows: 151, integratedSteps: 4850, policyRows: 1001, separationAttempts: 0, separationTransitions: 0 })
  expect(evidence.separation).toEqual({ scheduledAtMs: null, attemptedAtMs: null, outcome: 'not-requested', reason: null, before: null, after: null, parcel: null })
  expect(evidence.physical.length).toBe(5001)
  expect(evidence.policy.length).toBe(1001)
  expect(evidence.physical.every((row, index) => row.atMs === index * 4)).toBe(true)
  expect(evidence.policy.every((row, index) => row.atMs === index * 20)).toBe(true)
  const held = evidence.physical.filter(row => row.stepKind === 'held-support')
  const integrated = evidence.physical.filter(row => row.stepKind === 'integrated')
  expect(held.length).toBe(151)
  expect(integrated.length).toBe(4850)
  expect(held.every(row => row.atMs <= 600 && row.body.accelerationMps2.every(n => n === 0))).toBe(true)
  expect(integrated[0]!.atMs).toBe(604)
  expect(integrated.at(-1)!.atMs).toBe(20000)
  expect(evidence.physical.every(row => row.load.properties.phase === 'attached' && row.load.properties.totalMassKg === 1.6 && row.load.properties.pointMassKg === 0.1 && row.load.properties.forwardM === 0)).toBe(true)
  expect(integrated.every(row => !row.body.groundContact)).toBe(true)

  // Independent first integrated Newton/motor-lag case. The old controller still requests its base-mass hover.
  const first = integrated[0]!, firstActualMotor = 0.8 * (1 - Math.exp(-0.004 / 0.04))
  expect(first.commandAppliedN).toEqual([0.8, 0.8, 0.8, 0.8])
  for (const actual of first.body.actualMotorsN) expect(Math.abs(actual - firstActualMotor)).toBeLessThanOrEqual(1e-12)
  expect(Math.abs(first.body.accelerationMps2[2] - (9.80665 - 4 * firstActualMotor / 1.6))).toBeLessThanOrEqual(1e-12)

  const required = evidence.policy.filter(row => row.atMs >= 600)
  expect(evidence.policy.filter(row => row.atMs < 600).every(row => row.control === null)).toBe(true)
  expect(required.every(row => row.control !== null && !row.control.inhibited && row.estimate.nowMs === row.atMs && row.estimate.frameQualified && row.estimate.healthy.every(Boolean))).toBe(true)
  expect(required.every(row => row.supervisor.state === 'autonomous' && row.supervisor.scope[0] === '123' && row.supervisor.scope[1] === '55' && row.supervisor.lastCheckedAtMs === row.atMs && row.supervisor.leaseUntilMs !== null && row.supervisor.leaseUntilMs > row.atMs)).toBe(true)
  expect(required.every(row => row.board.bootId === '55' && row.board.epoch === row.supervisor.epoch && row.board.fault === null && row.board.lastCheckedAtMs === row.atMs && row.board.expiresAtMs !== null && row.board.expiresAtMs > row.atMs && row.board.expiresAtMs <= row.supervisor.leaseUntilMs!)).toBe(true)
  expect(required.every(row => row.control!.motorsN.every((n, index) => n === row.board.motorsN[index]))).toBe(true)
  expect(required.every((row, index) => index === 0 || row.board.frameSequence > required[index - 1]!.board.frameSequence)).toBe(true)
  expect(required.every(row => row.imu !== null && row.imu.stamp.healthy && row.control!.rateCapturedAtMs === row.imu.stamp.capturedAtMs && row.estimate.attitude!.capturedAtMs === row.imu.stamp.capturedAtMs)).toBe(true)

  const at12000 = evidence.policy.find(row => row.atMs === 12000)!
  expect(at12000.imu!.stamp.capturedAtMs).toBe(11980)
  expect(at12000.imu!.stamp.receivedAtMs).toBe(11984)
  expect(at12000.imu!.stamp.capturedUs).toBe('12980000')
  expect(at12000.gnss!.stamp.capturedAtMs).toBe(11900)
  expect(at12000.gnss!.stamp.receivedAtMs).toBe(11904)
  expect(at12000.gnss!.stamp.capturedUs).toBe('12900000')

  // Evaluate retained 4 ms facts independently, rather than trusting reported maxima or the old 200 ms trace.
  const tilt = integrated.map(row => Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (row.body.quaternionWxyz[1] ** 2 + row.body.quaternionWxyz[2] ** 2)))))
  const rate = integrated.map(row => Math.hypot(...row.body.angularRateRadS))
  expect(Math.max(...tilt)).toBeLessThanOrEqual(0.35)
  expect(Math.max(...rate)).toBeLessThanOrEqual(2)
  expect(evidence.physical.every(row => [...row.body.actualMotorsN, ...row.commandAppliedN, ...row.commandNextN].every(n => Number.isFinite(n) && n >= 0 && n <= 10))).toBe(true)
  let previous = [0, 0, 0, 0], maximumSlew = 0
  for (const row of required) {
    maximumSlew = Math.max(maximumSlew, ...row.control!.motorsN.map((n, index) => Math.abs(n - previous[index]!) / 0.02))
    expect(row.control!.motorsN.every((n, index) => independentCargoStep(previous[index]!, n))).toBe(true)
    previous = [...row.control!.motorsN]
  }
  // Prospective numerical amendment: exact rounded endpoints AND an a-priori reconstruction ceiling.
  // This preserves the reported raw value and does not assert an exact-real or hardware 40 N/s bound.
  expect(maximumSlew).toBeLessThanOrEqual(40 + 2 ** -44)
  expect(result.metrics.maxCommandSlewNPerS).toBe(maximumSlew)
  expect(evidence.evaluation.metrics.maxCommandSlewNPerS).toBe(maximumSlew)
  const tailErrors = integrated.filter(row => row.atMs >= 18000 && row.atMs <= 20000).map(row => Math.hypot(row.body.positionM[0], row.body.positionM[1], row.body.positionM[2] + 1))
  expect(tailErrors.length).toBe(501)
  expect(Math.max(...tailErrors)).toBeLessThanOrEqual(0.4)
  expect(Math.sqrt(tailErrors.reduce((sum, n) => sum + n * n, 0) / tailErrors.length)).toBeLessThanOrEqual(0.3)
  expect(evidence.evaluation.reasons).toEqual([])
  expect(evidence.evaluation.faultCharacterizationPassed).toBeNull()
  expect(evidence.evaluation.metrics.separationCount).toBe(0)
  expect(evidence.evaluation.metrics.conservation).toBeNull()
  expect(evidence.final.experimentEnded).toBe(true)
  expect(evidence.final.landingPerformed).toBe(false)
  expect(evidence.final.load.properties.phase).toBe('attached')
  expect(evidence.final.supervisor.state).toBe('autonomous')
  expect(evidence.final.board.motorsN.some(n => n > 0)).toBe(true)
  expect(evidence.final.board.expiresAtMs).toBeGreaterThan(20000)

  // Evidence-local bounds only. Complete CargoLoadRun wrapper accounting remains a later authorized seam.
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  expect(evidence.physical.every(row => bytes(row) <= 2048)).toBe(true)
  expect(evidence.policy.every(row => bytes(row) <= 2048)).toBe(true)
  expect(bytes({ ...evidence, physical: [], policy: [] })).toBeLessThanOrEqual(131072)
  expect(new TextEncoder().encode(JSON.stringify(evidence) + '\n').length).toBeLessThanOrEqual(12582912)
}, 60000)

test('forward carried cargo uses actual shifted dynamics and remains nominal through the owned raw-sensor loop', () => {
  const result = simulateMultirotor({ cargoLoadCase: 'forward-carried' })
  const evidence = result.cargoLoadEvidence
  expect(evidence.scenario).toBe('forward-carried')
  expect(evidence.model.loadForwardM).toBe(0.08)
  expect(evidence.model.massAwareController).toBe(false)
  expect(evidence.model.inertialPositionFusion).toBe(false)
  expect(evidence.model.separationAtMs).toBeNull()
  expect(evidence.counts).toEqual({ worldSnapshots: 5001, heldSupportRows: 151, integratedSteps: 4850, policyRows: 1001, separationAttempts: 0, separationTransitions: 0 })
  expect(evidence.separation).toEqual({ scheduledAtMs: null, attemptedAtMs: null, outcome: 'not-requested', reason: null, before: null, after: null, parcel: null })
  expect(evidence.physical.every((row, i) => row.atMs === i * 4 && row.load.properties.phase === 'attached' && row.load.properties.totalMassKg === 1.6 && row.load.properties.forwardM === 0.08)).toBe(true)
  expect(evidence.policy.every((row, i) => row.atMs === i * 20)).toBe(true)
  const first = evidence.physical.find(row => row.atMs === 604)!
  const actualMotor = 0.8 * (1 - Math.exp(-0.004 / 0.04)), thrust = 4 * actualMotor
  expect(first.commandAppliedN).toEqual([0.8, 0.8, 0.8, 0.8])
  for (const n of first.body.actualMotorsN) expect(Math.abs(n - actualMotor)).toBeLessThanOrEqual(1e-12)
  expect(Math.abs(first.load.properties.cgBodyM[0] - 0.005)).toBeLessThanOrEqual(1e-12)
  expect(Math.abs(first.load.properties.inertiaDiagonalKgM2[1] - 0.0306)).toBeLessThanOrEqual(1e-12)
  expect(Math.abs(first.motorTorqueAtCgNm[1] - (-0.005 * thrust))).toBeLessThanOrEqual(1e-12)
  expect(Math.abs(first.alphaStepRadS2[1] - (-0.005 * thrust / 0.0306))).toBeLessThanOrEqual(1e-12)
  expect(Math.abs(first.body.angularRateRadS[1] - (-0.005 * thrust / 0.0306 * 0.004))).toBeLessThanOrEqual(1e-12)
  const integrated = evidence.physical.filter(row => row.stepKind === 'integrated')
  expect(integrated.length).toBe(4850)
  expect(integrated.every(row => !row.body.groundContact)).toBe(true)
  expect(Math.max(...integrated.map(row => Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (row.body.quaternionWxyz[1] ** 2 + row.body.quaternionWxyz[2] ** 2))))))).toBeLessThanOrEqual(0.35)
  expect(Math.max(...integrated.map(row => Math.hypot(...row.body.angularRateRadS)))).toBeLessThanOrEqual(2)
  expect(evidence.physical.every(row => [...row.body.actualMotorsN, ...row.commandAppliedN, ...row.commandNextN].every(n => Number.isFinite(n) && n >= 0 && n <= 10))).toBe(true)
  const required = evidence.policy.filter(row => row.atMs >= 600)
  expect(required.every(row => row.control !== null && !row.control.inhibited && row.estimate.frameQualified && row.estimate.healthy.every(Boolean) && row.supervisor.state === 'autonomous' && row.supervisor.scope[0] === '123' && row.supervisor.scope[1] === '55' && row.supervisor.lastCheckedAtMs === row.atMs && row.supervisor.leaseUntilMs !== null && row.supervisor.leaseUntilMs > row.atMs)).toBe(true)
  expect(required.every(row => row.board.bootId === '55' && row.board.epoch === row.supervisor.epoch && row.board.fault === null && row.board.lastCheckedAtMs === row.atMs && row.board.expiresAtMs !== null && row.board.expiresAtMs > row.atMs && row.board.expiresAtMs <= row.supervisor.leaseUntilMs! && row.board.motorsN.every((n, i) => n === row.control!.motorsN[i]))).toBe(true)
  expect(required.every((row, i) => row.imu !== null && row.imu.stamp.healthy && row.control!.rateCapturedAtMs === row.imu.stamp.capturedAtMs && row.estimate.attitude!.capturedAtMs === row.imu.stamp.capturedAtMs && (i === 0 || row.board.frameSequence > required[i - 1]!.board.frameSequence))).toBe(true)
  let previous = [0, 0, 0, 0], maximumSlew = 0
  for (const row of required) {
    expect(row.control!.motorsN.every((n, i) => independentCargoStep(previous[i]!, n))).toBe(true)
    maximumSlew = Math.max(maximumSlew, ...row.control!.motorsN.map((n, i) => Math.abs(n - previous[i]!) / 0.02))
    previous = [...row.control!.motorsN]
  }
  expect(maximumSlew).toBeLessThanOrEqual(40 + 2 ** -44)
  expect(result.metrics.maxCommandSlewNPerS).toBe(maximumSlew)
  expect(evidence.evaluation.metrics.maxCommandSlewNPerS).toBe(maximumSlew)
  const at12000 = evidence.policy.find(row => row.atMs === 12000)!
  expect(at12000.imu!.stamp.capturedAtMs).toBe(11980)
  expect(at12000.imu!.stamp.receivedAtMs).toBe(11984)
  expect(at12000.imu!.stamp.capturedUs).toBe('12980000')
  expect(at12000.gnss!.stamp.capturedAtMs).toBe(11900)
  expect(at12000.gnss!.stamp.receivedAtMs).toBe(11904)
  expect(at12000.gnss!.stamp.capturedUs).toBe('12900000')
  const tail = integrated.filter(row => row.atMs >= 18000).map(row => Math.hypot(row.body.positionM[0], row.body.positionM[1], row.body.positionM[2] + 1))
  expect(tail.length).toBe(501)
  expect(Math.max(...tail)).toBeLessThanOrEqual(0.4)
  expect(Math.sqrt(tail.reduce((sum, n) => sum + n * n, 0) / tail.length)).toBeLessThanOrEqual(0.3)
  expect(evidence.evaluation.reasons).toEqual([])
  expect(evidence.evaluation.metrics.conservation).toBeNull()
  expect(evidence.evaluation.faultCharacterizationPassed).toBeNull()
  expect(evidence.final.load.properties.phase).toBe('attached')
  expect(evidence.final.supervisor.state).toBe('autonomous')
  expect(evidence.final.board.expiresAtMs).toBeGreaterThan(20000)
  expect(evidence.final.experimentEnded).toBe(true)
  expect(evidence.final.landingPerformed).toBe(false)
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  expect(evidence.physical.every(row => bytes(row) <= 2048)).toBe(true)
  expect(evidence.policy.every(row => bytes(row) <= 2048)).toBe(true)
  expect(bytes({ ...evidence, physical: [], policy: [] })).toBeLessThanOrEqual(131072)
  expect(bytes(evidence) + 1).toBeLessThanOrEqual(12582912)
}, 60000)

type CargoTestV3 = [number, number, number]
type CargoTestQ4 = [number, number, number, number]
function cargoTestAdd(a: CargoTestV3, b: CargoTestV3): CargoTestV3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
function cargoTestSub(a: CargoTestV3, b: CargoTestV3): CargoTestV3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function cargoTestScale(a: CargoTestV3, k: number): CargoTestV3 { return [a[0] * k, a[1] * k, a[2] * k] }
function cargoTestCross(a: CargoTestV3, b: CargoTestV3): CargoTestV3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
function cargoTestRotate([w, x, y, z]: CargoTestQ4, v: CargoTestV3): CargoTestV3 {
  return [(1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y - w * z) * v[1] + 2 * (x * z + w * y) * v[2], 2 * (x * y + w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z - w * x) * v[2], 2 * (x * z - w * y) * v[0] + 2 * (y * z + w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2]]
}
function cargoTestVector(actual: readonly number[], expected: readonly number[]) {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(1e-12)
}

test('forward cargo separates only after the qualified current 12000 opportunity and conserves the actual airborne split', () => {
  const result = simulateMultirotor({ cargoLoadCase: 'forward-separated' })
  const evidence = result.cargoLoadEvidence, separation = evidence.separation
  expect(separation.outcome).toBe('separated')
  expect(separation.reason).toBe('prescribed-zero-ejection')
  expect(separation.scheduledAtMs).toBe(12000)
  expect(separation.attemptedAtMs).toBe(12000)
  expect(evidence.counts).toEqual({ worldSnapshots: 5001, heldSupportRows: 151, integratedSteps: 4850, policyRows: 1001, separationAttempts: 1, separationTransitions: 1 })
  const pre = evidence.physical.find(row => row.atMs === 12000)!, post = evidence.physical.find(row => row.atMs === 12004)!
  expect(pre.load.properties.phase).toBe('attached')
  expect(pre.load.properties.totalMassKg).toBe(1.6)
  expect(post.load.properties.phase).toBe('separated')
  expect(post.load.properties.totalMassKg).toBe(1.5)
  expect(post.load.properties.cgBodyM).toEqual([0, 0, 0])
  expect(post.load.properties.inertiaDiagonalKgM2).toEqual([0.03, 0.03, 0.05])
  expect(evidence.physical.every(row => row.load.properties.phase === (row.atMs <= 12000 ? 'attached' : 'separated'))).toBe(true)
  const at12000 = evidence.policy.find(row => row.atMs === 12000)!
  expect(at12000.readiness.qualified).toBe(true)
  expect(at12000.readiness.count).toBe(26)
  expect(at12000.readiness.startAtMs).toBe(11500)
  expect(at12000.readiness.lastImuSequence).toBe(at12000.imu!.stamp.sequence)
  expect(at12000.readiness.lastImuCapturedUs).toBe(at12000.imu!.stamp.capturedUs)
  const admission = evidence.policy.filter(row => row.atMs >= 11500 && row.atMs <= 12000)
  expect(admission.length).toBe(26)
  expect(admission.every((row, i) => row.atMs === 11500 + i * 20 && row.estimate.nowMs === row.atMs && row.estimate.bootId === '55' && row.estimate.frameQualified && row.estimate.healthy.every(Boolean) && row.estimate.origin!.every((n, j) => n === [0, 0, 100][j]) && row.estimate.resets.every((n, j) => n === at12000.estimate.resets[j]))).toBe(true)
  expect(admission.every(row => Math.hypot(...row.estimate.position!.velocityMps) <= 0.3 && Math.hypot(row.estimate.position!.positionM[0], row.estimate.position!.positionM[1], row.estimate.position!.positionM[2] + 1) <= 0.3 && Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (row.estimate.attitude!.quaternionWxyz[1] ** 2 + row.estimate.attitude!.quaternionWxyz[2] ** 2)))) <= 0.25)).toBe(true)
  expect(admission.every((row, i) => row.imu !== null && row.imu.stamp.healthy && row.imu.stamp.ageUpperMs !== null && row.imu.stamp.ageUpperMs <= 60 && row.imu.stamp.capturedAtMs <= row.atMs && row.imu.stamp.receivedAtMs <= row.atMs && row.control !== null && !row.control.inhibited && row.control.rateCapturedAtMs === row.imu.stamp.capturedAtMs && row.estimate.attitude!.capturedAtMs === row.imu.stamp.capturedAtMs && (i === 0 || (row.imu.stamp.sequence > admission[i - 1]!.imu!.stamp.sequence && BigInt(row.imu.stamp.capturedUs) > BigInt(admission[i - 1]!.imu!.stamp.capturedUs) && row.imu.stamp.capturedAtMs > admission[i - 1]!.imu!.stamp.capturedAtMs)))).toBe(true)
  expect(admission.every(row => row.supervisor.state === 'autonomous' && row.supervisor.scope[0] === '123' && row.supervisor.scope[1] === '55' && row.supervisor.lastCheckedAtMs === row.atMs && row.supervisor.leaseUntilMs !== null && row.supervisor.leaseUntilMs > row.atMs && row.board.bootId === '55' && row.board.epoch === row.supervisor.epoch && row.board.fault === null && row.board.lastCheckedAtMs === row.atMs && row.board.expiresAtMs !== null && row.board.expiresAtMs > row.atMs && row.board.expiresAtMs <= row.supervisor.leaseUntilMs && row.board.motorsN.every((n, i) => n === row.control!.motorsN[i]))).toBe(true)
  const before = separation.before!, after = separation.after!, parcel = separation.parcel!
  expect(Object.keys(before)).toEqual(['properties', 'bodyPositionM', 'bodyVelocityMps', 'quaternionWxyz', 'angularRateRadS', 'actualMotorsN', 'centerPositionM', 'centerVelocityMps'])
  expect(Object.keys(after)).toEqual(Object.keys(before))
  for (const key of ['bodyPositionM', 'bodyVelocityMps', 'quaternionWxyz', 'angularRateRadS', 'actualMotorsN'] as const) cargoTestVector(after[key], before[key])
  cargoTestVector(before.bodyPositionM, pre.body.positionM)
  cargoTestVector(before.bodyVelocityMps, pre.body.velocityMps)
  cargoTestVector(before.actualMotorsN, pre.body.actualMotorsN)
  const q = before.quaternionWxyz, w = before.angularRateRadS
  const pC = cargoTestAdd(before.bodyPositionM, cargoTestRotate(q, [0.005, 0, 0]))
  const vC = cargoTestAdd(before.bodyVelocityMps, cargoTestRotate(q, cargoTestCross(w, [0.005, 0, 0])))
  const pP = cargoTestAdd(before.bodyPositionM, cargoTestRotate(q, [0.08, 0, 0]))
  const vP = cargoTestAdd(before.bodyVelocityMps, cargoTestRotate(q, cargoTestCross(w, [0.08, 0, 0])))
  cargoTestVector(before.centerPositionM, pC)
  cargoTestVector(before.centerVelocityMps, vC)
  cargoTestVector(after.centerPositionM, after.bodyPositionM)
  cargoTestVector(after.centerVelocityMps, after.bodyVelocityMps)
  expect(parcel.massKg).toBe(0.1)
  cargoTestVector(parcel.positionM, pP)
  cargoTestVector(parcel.velocityMps, vP)
  const origin: CargoTestV3 = [1, -2, 0.5]
  const P0 = cargoTestScale(vC, 1.6), P1 = cargoTestAdd(cargoTestScale(after.bodyVelocityMps, 1.5), cargoTestScale(vP, 0.1))
  const H0 = cargoTestAdd(cargoTestCross(cargoTestSub(pC, origin), P0), cargoTestRotate(q, [0.03 * w[0], 0.0306 * w[1], 0.0506 * w[2]]))
  const H1 = cargoTestAdd(cargoTestAdd(cargoTestCross(cargoTestSub(after.bodyPositionM, origin), cargoTestScale(after.bodyVelocityMps, 1.5)), cargoTestRotate(q, [0.03 * w[0], 0.03 * w[1], 0.05 * w[2]])), cargoTestCross(cargoTestSub(pP, origin), cargoTestScale(vP, 0.1)))
  const norm2 = (v: CargoTestV3) => v.reduce((sum, n) => sum + n * n, 0)
  const K0 = 0.5 * 1.6 * norm2(vC) + 0.5 * (0.03 * w[0] ** 2 + 0.0306 * w[1] ** 2 + 0.0506 * w[2] ** 2)
  const K1 = 0.5 * 1.5 * norm2(after.bodyVelocityMps) + 0.5 * (0.03 * w[0] ** 2 + 0.03 * w[1] ** 2 + 0.05 * w[2] ** 2) + 0.5 * 0.1 * norm2(vP)
  const U0 = -1.6 * 9.80665 * pC[2], U1 = -1.5 * 9.80665 * after.bodyPositionM[2] - 0.1 * 9.80665 * pP[2]
  for (const [a, b] of [...P0.map((n, i) => [n, P1[i]!] as const), ...H0.map((n, i) => [n, H1[i]!] as const), [K0, K1], [U0, U1]]) expect(Math.abs(a! - b!)).toBeLessThanOrEqual(1e-10 + 1e-10 * Math.max(Math.abs(a!), Math.abs(b!)))
  const conservation = evidence.evaluation.metrics.conservation!
  expect(conservation.passed).toBe(true)
  expect(conservation.originM).toEqual(origin)
  cargoTestVector(conservation.linearResidual, cargoTestSub(P0, P1))
  cargoTestVector(conservation.angularResidual, cargoTestSub(H0, H1))
  expect(Math.abs(conservation.kineticResidualJ - (K0 - K1))).toBeLessThanOrEqual(1e-12)
  expect(Math.abs(conservation.potentialResidualJ - (U0 - U1))).toBeLessThanOrEqual(1e-12)
  expect(conservation.continuityMax).toBeLessThanOrEqual(1e-12)
  expect(at12000.imu!.stamp.capturedAtMs).toBe(11980)
  expect(at12000.gnss!.stamp.capturedAtMs).toBe(11900)
  const at12020 = evidence.policy.find(row => row.atMs === 12020)!, at12040 = evidence.policy.find(row => row.atMs === 12040)!, at12120 = evidence.policy.find(row => row.atMs === 12120)!
  expect(at12020.imu!.stamp.capturedAtMs).toBe(12000)
  expect(at12020.imu!.stamp.receivedAtMs).toBe(12004)
  expect(at12040.imu!.stamp.capturedAtMs).toBe(12020)
  expect(at12040.imu!.stamp.receivedAtMs).toBe(12024)
  expect(at12040.imu!.stamp.capturedUs).toBe('13020000')
  expect(at12120.gnss!.stamp.capturedAtMs).toBe(12100)
  expect(at12120.gnss!.stamp.receivedAtMs).toBe(12104)
  expect(evidence.policy.filter(row => row.atMs >= 600).every(row => row.control !== null && !row.control.inhibited && row.estimate.frameQualified && row.estimate.healthy.every(Boolean) && row.supervisor.state === 'autonomous' && row.board.fault === null && row.board.expiresAtMs !== null && row.board.expiresAtMs > row.atMs)).toBe(true)
  const integrated = evidence.physical.filter(row => row.stepKind === 'integrated')
  expect(integrated.every(row => !row.body.groundContact)).toBe(true)
  expect(Math.max(...integrated.map(row => Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (row.body.quaternionWxyz[1] ** 2 + row.body.quaternionWxyz[2] ** 2))))))).toBeLessThanOrEqual(0.35)
  expect(Math.max(...integrated.map(row => Math.hypot(...row.body.angularRateRadS)))).toBeLessThanOrEqual(2)
  let previous = [0, 0, 0, 0], maximumSlew = 0
  for (const row of evidence.policy.filter(row => row.atMs >= 600)) { expect(row.control!.motorsN.every((n, i) => independentCargoStep(previous[i]!, n))).toBe(true); maximumSlew = Math.max(maximumSlew, ...row.control!.motorsN.map((n, i) => Math.abs(n - previous[i]!) / 0.02)); previous = [...row.control!.motorsN] }
  expect(maximumSlew).toBeLessThanOrEqual(40 + 2 ** -44)
  expect(evidence.evaluation.metrics.maxCommandSlewNPerS).toBe(maximumSlew)
  const tail = integrated.filter(row => row.atMs >= 18000).map(row => Math.hypot(row.body.positionM[0], row.body.positionM[1], row.body.positionM[2] + 1))
  expect(tail.length).toBe(501)
  expect(Math.max(...tail)).toBeLessThanOrEqual(0.4)
  expect(Math.sqrt(tail.reduce((sum, n) => sum + n * n, 0) / tail.length)).toBeLessThanOrEqual(0.3)
  expect(evidence.evaluation.reasons).toEqual([])
  expect(evidence.final.load.properties.phase).toBe('separated')
  expect(evidence.final.experimentEnded).toBe(true)
  expect(evidence.final.landingPerformed).toBe(false)
  expect(evidence.physical.every(row => Buffer.byteLength(JSON.stringify(row)) <= 2048)).toBe(true)
  expect(evidence.policy.every(row => Buffer.byteLength(JSON.stringify(row)) <= 2048)).toBe(true)
  expect(Buffer.byteLength(JSON.stringify({ ...evidence, physical: [], policy: [] }))).toBeLessThanOrEqual(131072)
  expect(Buffer.byteLength(JSON.stringify(evidence)) + 1).toBeLessThanOrEqual(12582912)
}, 60000)

test('cargo link loss revokes at 3000 retains physical motor decay and refuses the sole separation without claiming recovery', () => {
  const result = simulateMultirotor({ cargoLoadCase: 'link-loss' })
  const evidence = result.cargoLoadEvidence
  expect(result.authority!.scenario).toBe('link-loss')
  expect(evidence.scenario).toBe('link-loss')
  expect(evidence.model.loadForwardM).toBe(0.08)
  expect(evidence.model.separationAtMs).toBe(12000)
  expect(evidence.counts).toEqual({ worldSnapshots: 5001, heldSupportRows: 151, integratedSteps: 4850, policyRows: 1001, separationAttempts: 1, separationTransitions: 0 })
  expect(evidence.evaluation.reasons).toEqual(['cargo-load-authority-lost', 'cargo-load-separation-refused'])
  expect(evidence.evaluation.faultCharacterizationPassed).toBe(true)
  expect(evidence.evaluation.metrics.firstAuthorityLossAtMs).toBe(3000)
  expect(evidence.evaluation.metrics.firstBoardZeroAtMs).toBe(3000)
  expect(result.authority!.firstRevocationMs).toBe(3000)
  expect(result.authority!.firstZeroMs).toBe(3000)
  expect(evidence.separation.scheduledAtMs).toBe(12000)
  expect(evidence.separation.attemptedAtMs).toBe(12000)
  expect(evidence.separation.outcome).toBe('refused')
  expect(evidence.separation.reason).toBe('authority-not-current')
  expect(evidence.separation.before!.properties.phase).toBe('attached')
  expect(evidence.separation.after).toBeNull()
  expect(evidence.separation.parcel).toBeNull()
  expect(evidence.evaluation.metrics.conservation).toBeNull()
  expect(evidence.physical.every(row => row.load.properties.phase === 'attached' && row.load.properties.totalMassKg === 1.6)).toBe(true)
  const at3000 = evidence.physical.find(row => row.atMs === 3000)!, at3004 = evidence.physical.find(row => row.atMs === 3004)!
  expect(at3000.commandAppliedN.some(n => n > 0)).toBe(true)
  expect(at3000.body.actualMotorsN.every(n => n > 0)).toBe(true)
  expect(at3000.commandNextN).toEqual([0, 0, 0, 0])
  expect(at3004.commandAppliedN).toEqual([0, 0, 0, 0])
  for (let i = 0; i < 4; i++) expect(Math.abs(at3004.body.actualMotorsN[i]! - at3000.body.actualMotorsN[i]! * Math.exp(-0.004 / 0.04))).toBeLessThanOrEqual(1e-12)
  expect(evidence.physical.filter(row => row.atMs >= 3004).every(row => row.commandAppliedN.every(n => n === 0) && row.commandNextN.every(n => n === 0))).toBe(true)
  expect(evidence.policy.filter(row => row.atMs >= 3000).every(row => row.supervisor.state === 'failsafe' && row.board.motorsN.every(n => n === 0) && row.board.expiresAtMs === null && row.control !== null && row.control.inhibited)).toBe(true)
  expect(evidence.policy.filter(row => row.atMs >= 600 && row.atMs < 3000).every(row => row.control !== null && !row.control.inhibited && row.estimate.frameQualified && row.estimate.healthy.every(Boolean) && row.supervisor.state === 'autonomous')).toBe(true)
  expect(evidence.physical.some(row => row.atMs > 3000 && row.body.groundContact)).toBe(true)
  const at12000 = evidence.policy.find(row => row.atMs === 12000)!
  expect(at12000.readiness.qualified).toBe(false)
  expect(at12000.readiness.count).toBe(0)
  expect(at12000.imu!.stamp.capturedAtMs).toBe(11980)
  expect(at12000.gnss!.stamp.capturedAtMs).toBe(11900)
  expect(evidence.final.load.properties.phase).toBe('attached')
  expect(evidence.final.supervisor.state).toBe('failsafe')
  expect(evidence.final.board.motorsN).toEqual([0, 0, 0, 0])
  expect(evidence.final.board.expiresAtMs).toBeNull()
  expect(evidence.final.experimentEnded).toBe(true)
  expect(evidence.final.landingPerformed).toBe(false)
  expect(evidence.physical.every(row => Buffer.byteLength(JSON.stringify(row)) <= 2048)).toBe(true)
  expect(evidence.policy.every(row => Buffer.byteLength(JSON.stringify(row)) <= 2048)).toBe(true)
  expect(Buffer.byteLength(JSON.stringify({ ...evidence, physical: [], policy: [] }))).toBeLessThanOrEqual(131072)
  expect(Buffer.byteLength(JSON.stringify(evidence)) + 1).toBeLessThanOrEqual(12582912)
}, 60000)

test('strict cargo wrapper projects one owned centered characterization with the complete bounded JSON envelope', async () => {
  const { simulateCargoLoad } = await import('../../resources/functions/drone/cargo/load')
  const run = simulateCargoLoad()
  expect(Object.keys(run)).toEqual(['version', 'evidence', 'profile', 'scenario', 'status', 'reason', 'physicalFlightEnabled', 'boardOutputsInhibited', 'identityAuthenticated', 'capabilities', 'model', 'counts', 'separation', 'physical', 'policy', 'evaluation', 'final'])
  expect(run.version).toBe(1)
  expect(run.evidence).toBe('owned-airborne-cargo-load-characterization')
  expect(run.profile).toBe('forward-point-load-v1')
  expect(run.scenario).toBe('centered-carried')
  expect(run.status).toBe('characterized')
  expect(run.reason).toBeNull()
  expect(run.physicalFlightEnabled).toBe(false)
  expect(run.boardOutputsInhibited).toBe(true)
  expect(run.identityAuthenticated).toBe(false)
  expect(run.capabilities).toEqual({ deliveryPerformed: false, releaseMechanismVerified: false, custodyVerified: false, recipientConfirmed: false, missionExecuted: false, energyMarginQualified: false })
  expect(run.counts).toEqual({ worldSnapshots: 5001, heldSupportRows: 151, integratedSteps: 4850, policyRows: 1001, separationAttempts: 0, separationTransitions: 0 })
  expect(run.physical.length).toBe(5001)
  expect(run.policy.length).toBe(1001)
  expect(Object.hasOwn(run, 'trace')).toBe(false)
  expect(Object.hasOwn(run, 'estimate')).toBe(false)
  expect(Object.hasOwn(run, 'authority')).toBe(false)
  expect(run.evaluation.reasons).toEqual([])
  expect(run.final.board.motorsN.some(n => n > 0)).toBe(true)
  expect(run.final.board.expiresAtMs).toBeGreaterThan(20000)
  expect(run.final.experimentEnded).toBe(true)
  expect(run.final.landingPerformed).toBe(false)
  expect(run.physical.every(row => Buffer.byteLength(JSON.stringify(row)) <= 2048)).toBe(true)
  expect(run.policy.every(row => Buffer.byteLength(JSON.stringify(row)) <= 2048)).toBe(true)
  expect(Buffer.byteLength(JSON.stringify({ ...run, physical: [], policy: [] }))).toBeLessThanOrEqual(131072)
  expect(Buffer.byteLength(JSON.stringify(run)) + 1).toBeLessThanOrEqual(12582912)
  const decoded = JSON.parse(JSON.stringify(run))
  expect(decoded.policy.find((row: { atMs: number }) => row.atMs === 12000).imu.stamp.capturedUs).toBe('12980000')
  expect(decoded.final.supervisor.scope).toEqual(['123', '55'])
}, 60000)

test('cargo wrapper rejects malformed own input without evaluating caller getters or disclosing descriptor failures', async () => {
  const { simulateCargoLoad } = await import('../../resources/functions/drone/cargo/load')
  let getters = 0
  const accessor = Object.defineProperty({}, 'scenario', { enumerable: true, get() { getters++; return 'centered-carried' } })
  const hidden = Object.defineProperty({}, 'scenario', { value: 'centered-carried', enumerable: false })
  const trapped = new Proxy({ scenario: 'centered-carried' }, { getOwnPropertyDescriptor() { throw new Error('private-cargo-descriptor-sentinel') } })
  const malformed: unknown[] = [null, [], new Date(), Object.create(null), Object.create({ scenario: 'centered-carried' }), { scenario: undefined }, { scenario: null }, { scenario: 1 }, { scenario: ['centered-carried'] }, { scenario: new String('centered-carried') }, { scenario: '' }, { scenario: 'hover' }, { scenario: 'centered-carried', factory() { throw new Error('never') } }, { scenario: 'centered-carried', [Symbol('extra')]: true }, accessor, hidden, trapped]
  for (const value of malformed) {
    let failure: unknown
    try { simulateCargoLoad(value) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(TypeError)
    expect((failure as Error).message).toBe('cargo-load-input')
  }
  expect(getters).toBe(0)
})

test('owned cargo simulator options reject incompatible own values and bound descriptor failures before a world starts', () => {
  let getters = 0
  const accessor = Object.defineProperty({}, 'cargoLoadCase', { enumerable: true, get() { getters++; return 'centered-carried' } })
  const trapped = new Proxy({ cargoLoadCase: 'centered-carried' }, { getOwnPropertyDescriptor() { throw new Error('private-cargo-options-sentinel') } })
  const malformed: unknown[] = [{ cargoLoadCase: undefined }, { cargoLoadCase: ['centered-carried'] }, { cargoLoadCase: 'centered-carried', scenario: 'step' }, { cargoLoadCase: 'centered-carried', seconds: 19 }, { cargoLoadCase: 'centered-carried', sensorDelayMs: 1 }, { cargoLoadCase: 'centered-carried', physicsStepMs: 2 }, { cargoLoadCase: 'link-loss', authorityScenario: 'nominal' }, { cargoLoadCase: 'centered-carried', factory() {} }, { cargoLoadCase: 'centered-carried', [Symbol('extra')]: 1 }, accessor, trapped]
  for (const value of malformed) {
    let failure: unknown
    try { simulateMultirotor(value as never) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(TypeError)
    expect((failure as Error).message).toBe('cargo-load-options')
  }
  expect(getters).toBe(0)
})

test('cargo wrapper preserves characterized versus unqualified outcomes and bounded summaries for every closed case', async () => {
  const { simulateCargoLoad, cargoLoadSummary } = await import('../../resources/functions/drone/cargo/load')
  for (const scenario of ['forward-carried', 'forward-separated', 'link-loss'] as const) {
    const run = simulateCargoLoad({ scenario }), summary = cargoLoadSummary(run)
    expect(run.scenario).toBe(scenario)
    expect(run.status).toBe(scenario === 'link-loss' ? 'unqualified' : 'characterized')
    expect(run.reason).toBe(scenario === 'link-loss' ? 'cargo-load-authority-lost' : null)
    expect(run.reason).toBe(run.evaluation.reasons[0] ?? null)
    expect(run.evaluation.faultCharacterizationPassed).toBe(scenario === 'link-loss' ? true : null)
    expect(summary.status).toBe(run.status)
    expect(summary.reason).toBe(run.reason)
    expect(summary.metrics).toEqual(run.evaluation.metrics)
    expect(summary.separation.beforeProperties).toEqual(run.separation.before?.properties ?? null)
    expect(summary.separation.afterProperties).toEqual(run.separation.after?.properties ?? null)
    expect(Object.hasOwn(summary, 'physical')).toBe(false)
    expect(Object.hasOwn(summary, 'policy')).toBe(false)
    expect(summary.final.landingPerformed).toBe(false)
    expect(summary.final.experimentEnded).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(summary)) + 1).toBeLessThanOrEqual(16384)
    expect(Buffer.byteLength(JSON.stringify({ ...run, physical: [], policy: [] }))).toBeLessThanOrEqual(131072)
    expect(Buffer.byteLength(JSON.stringify(run)) + 1).toBeLessThanOrEqual(12582912)
  }
}, 60000)
