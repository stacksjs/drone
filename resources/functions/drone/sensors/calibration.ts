import type { ImuCalibration, ImuMeasurement, PressureCalibration, PressureMeasurement, SensorCalibrationSet, SensorVector } from './types'

const vector = (v: unknown): v is SensorVector => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6)
function base(cal: { id: string, provenance: string, minC: number, maxC: number, referenceC: number }) {
  if (typeof cal.id !== 'string' || cal.id.length < 1 || cal.id.length > 80 || !['fixture', 'measured'].includes(cal.provenance)
    || ![cal.minC, cal.maxC, cal.referenceC].every(Number.isFinite) || cal.minC < -40 || cal.maxC > 85 || cal.minC >= cal.maxC || cal.referenceC < cal.minC || cal.referenceC > cal.maxC) throw new TypeError('Invalid calibration identity or temperature range')
}
export function validateSensorCalibrations(input: SensorCalibrationSet): SensorCalibrationSet {
  const cal = structuredClone(input)
  if (cal.imu) {
    base(cal.imu)
    const c = cal.imu
    for (const v of [c.axes, c.accelBias, c.gyroBias, c.accelScale, c.gyroScale, c.accelTempSlope, c.gyroTempSlope, c.accelNoiseStd, c.gyroNoiseStd]) if (!vector(v)) throw new TypeError('Invalid IMU calibration vector')
    if (c.axes.some(n => !Number.isInteger(n) || Math.abs(n) < 1 || Math.abs(n) > 3) || new Set(c.axes.map(Math.abs)).size !== 3) throw new TypeError('Mount axes must be a signed permutation')
    const permutation = c.axes.map(n => Math.abs(n) - 1)
    let sign = c.axes.reduce((p, n) => p * Math.sign(n), 1)
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (permutation[i]! > permutation[j]!) sign *= -1
    if (sign !== 1) throw new TypeError('Mount axes must preserve a right-handed frame')
    if ([...c.accelScale, ...c.gyroScale].some(n => n < 0.5 || n > 2) || [...c.accelNoiseStd, ...c.gyroNoiseStd].some(n => n <= 0 || n > 100)) throw new TypeError('Invalid scale or noise calibration')
  }
  if (cal.barometer) {
    base(cal.barometer)
    const c = cal.barometer
    if (![c.offsetPa, c.tempSlopePaPerC, c.noiseStdPa].every(Number.isFinite) || Math.abs(c.offsetPa) > 10000 || Math.abs(c.tempSlopePaPerC) > 1000 || c.noiseStdPa <= 0 || c.noiseStdPa > 10000) throw new TypeError('Invalid pressure calibration')
  }
  return cal
}
function rotate(v: SensorVector, axes: SensorVector): SensorVector { return axes.map(axis => Math.sign(axis) * v[Math.abs(axis) - 1]!) as SensorVector }
export function convertImu(payload: Uint8Array, cal?: ImuCalibration): ImuMeasurement {
  if (payload.length !== 16 || payload[14] !== 6 || payload[15] !== 6) throw new RangeError('Unsupported IMU scale/ODR profile')
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const temperatureC = view.getInt16(0, false) / 132.48 + 25
  const raw = Array.from({ length: 6 }, (_v, i) => view.getInt16(2 + 2 * i, false))
  if (raw.some(n => n === -32768 || n === 32767) || temperatureC < -40 || temperatureC > 85) throw new RangeError('IMU saturation or temperature outside sensor range')
  let specificForceMps2 = raw.slice(0, 3).map(n => n * 16 * 9.80665 / 32768) as SensorVector
  let angularRateRadS = raw.slice(3).map(n => n * 2000 / 32768 * Math.PI / 180) as SensorVector
  let specificForceVariance: SensorVector | null = null, angularRateVariance: SensorVector | null = null
  if (cal) {
    const dt = temperatureC - cal.referenceC
    specificForceMps2 = rotate(specificForceMps2.map((n, i) => (n - cal.accelBias[i]! - cal.accelTempSlope[i]! * dt) * cal.accelScale[i]!) as SensorVector, cal.axes)
    angularRateRadS = rotate(angularRateRadS.map((n, i) => (n - cal.gyroBias[i]! - cal.gyroTempSlope[i]! * dt) * cal.gyroScale[i]!) as SensorVector, cal.axes)
    const variance = (noise: SensorVector, scale: SensorVector) => cal.axes.map(axis => (noise[Math.abs(axis) - 1]! * scale[Math.abs(axis) - 1]!) ** 2) as SensorVector
    specificForceVariance = variance(cal.accelNoiseStd, cal.accelScale); angularRateVariance = variance(cal.gyroNoiseStd, cal.gyroScale)
  }
  return { frame: cal ? 'BODY_FRD' : 'SENSOR_XYZ', temperatureC, specificForceMps2, angularRateRadS, specificForceVariance, angularRateVariance }
}
/** Integer factory compensation follows BST-BMP280-DS001 section 3.11.3, using arbitrary-width integer intermediates. */
export function convertPressure(payload: Uint8Array, cal?: PressureCalibration): PressureMeasurement {
  if (payload.length !== 30) throw new RangeError('Invalid pressure register block')
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const adcP = BigInt((payload[0]! << 12) | (payload[1]! << 4) | (payload[2]! >> 4))
  const adcT = BigInt((payload[3]! << 12) | (payload[4]! << 4) | (payload[5]! >> 4))
  if (adcP === 0x80000n || adcT === 0x80000n) throw new RangeError('Pressure or temperature conversion was skipped')
  const coefficient = (i: number) => BigInt(i === 0 || i === 3 ? view.getUint16(6 + i * 2, true) : view.getInt16(6 + i * 2, true))
  const [t1, t2, t3, p1, p2, p3, p4, p5, p6, p7, p8, p9] = Array.from({ length: 12 }, (_v, i) => coefficient(i)) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
  if (t1 === 0n || t1 === 65535n || p1 === 0n || p1 === 65535n) throw new RangeError('Invalid BMP280 factory trim')
  const fine = (((adcT >> 3n) - (t1 << 1n)) * t2 >> 11n) + (((((adcT >> 4n) - t1) ** 2n) >> 12n) * t3 >> 14n)
  const temperatureC = Number((fine * 5n + 128n) >> 8n) / 100
  const x = fine - 128000n
  const offset = x * x * p6 + ((x * p5) << 17n) + (p4 << 35n)
  const divisor = (((1n << 47n) + ((x * x * p3 >> 8n) + ((x * p2) << 12n))) * p1) >> 33n
  if (divisor === 0n) throw new RangeError('Invalid BMP280 compensation divisor')
  let pressure = ((((1048576n - adcP) << 31n) - offset) * 3125n) / divisor
  pressure = ((pressure + (p9 * (pressure >> 13n) * (pressure >> 13n) >> 25n) + (p8 * pressure >> 19n)) >> 8n) + (p7 << 4n)
  let pressurePa = Number(pressure) / 256
  if (cal) pressurePa -= cal.offsetPa + cal.tempSlopePaPerC * (temperatureC - cal.referenceC)
  if (!Number.isFinite(pressurePa) || pressurePa < 30000 || pressurePa > 110000 || temperatureC < -40 || temperatureC > 85) throw new RangeError('Pressure or temperature outside sensor range')
  return { pressurePa, temperatureC, variancePa2: cal ? cal.noiseStdPa ** 2 : null }
}
