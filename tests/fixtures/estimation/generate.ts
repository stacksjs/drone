/** Analytic truth, Euler rotation equations, raw quantization and independent CRC32. No estimator imports. */
const boot = 0x7788n, g = 9.80665
const pending: { ready: number, hex: string }[] = [], truth: { atMs: number, eulerRad: number[], positionM: number[] }[] = []
function frame(kind: number, seq: number, at: number, payload: Uint8Array, uncertainty: number, delay: number) {
  const bytes = new Uint8Array(128), v = new DataView(bytes.buffer)
  bytes.set([68, 83, 1, kind]); v.setUint32(4, seq, true); v.setBigUint64(8, boot, true)
  v.setBigUint64(16, 1000000n + BigInt(at * 1000), true); v.setBigUint64(24, 1000000n + BigInt(Math.round((at + delay) * 1000)), true)
  v.setUint32(32, 9, true); v.setUint16(36, kind, true); v.setUint16(38, payload.length, true); v.setUint32(40, uncertainty, true)
  bytes.set(payload, 44); v.setUint32(124, Bun.hash.crc32(bytes.subarray(0, 124)), true)
  pending.push({ ready: at + delay, hex: bytes.toHex() })
}
for (let i = 0; i <= 300; i++) {
  const at = i * 20, t = Math.max(0, at / 1000 - 1)
  const roll = 0.2 * Math.sin(0.8 * t), pitch = 0.15 * Math.sin(0.5 * t), yaw = 0.25 * t
  const rd = at < 1000 ? 0 : 0.16 * Math.cos(0.8 * t), pd = at < 1000 ? 0 : 0.075 * Math.cos(0.5 * t), yd = at < 1000 ? 0 : 0.25
  const force = [g * Math.sin(pitch), -g * Math.sin(roll) * Math.cos(pitch), -g * Math.cos(roll) * Math.cos(pitch)]
  const rates = [rd - yd * Math.sin(pitch), pd * Math.cos(roll) + yd * Math.sin(roll) * Math.cos(pitch), -pd * Math.sin(roll) + yd * Math.cos(roll) * Math.cos(pitch)]
  const p = new Uint8Array(16), v = new DataView(p.buffer)
  force.forEach((value, n) => v.setInt16(2 + n * 2, Math.round(value / g * 2048) + (n === 0 ? i % 3 - 1 : 0), false))
  rates.forEach((value, n) => v.setInt16(8 + n * 2, Math.round(value / Math.PI * 180 / 2000 * 32768), false))
  p[14] = 6; p[15] = 6; frame(1, i + 1, at, p, 1000, 0.1)
  truth.push({ atMs: at, eulerRad: [roll, pitch, yaw], positionM: [2 * at / 1000, at / 1000, -0.5 * at / 1000] })
}
for (let i = 0; i <= 12; i++) {
  const at = i * 500, p = new Uint8Array(80), v = new DataView(p.buffer)
  v.setUint32(0, 100000 + at, true); p[20] = 3; p[21] = 1; p[23] = 12
  // Fixed independent WGS84 meridian/prime-vertical radii at latitude zero, plus height.
  v.setInt32(28, Math.round((2 * at / 1000) / 6335539.3272928195 * 180 / Math.PI * 1e7), true)
  v.setInt32(24, Math.round((at / 1000) / 6378237 * 180 / Math.PI * 1e7), true)
  v.setInt32(32, 100000 + at / 2, true); v.setInt32(36, 70000 + at / 2, true)
  v.setUint32(40, 200, true); v.setUint32(44, 300, true); v.setUint32(68, 20, true)
  v.setInt32(48, 2000, true); v.setInt32(52, 1000, true); v.setInt32(56, -500, true)
  frame(3, i + 1, at, p, 1000, 9) // Known synthetic measurement epoch only; physical GNSS remains unaligned.
}
const coefficients = [27504, 26435, -1000, 36477, -10685, 3024, 2855, 140, -7, 15500, -14600, 6000]
for (let i = 0; i <= 30; i++) {
  const p = new Uint8Array(30), v = new DataView(p.buffer)
  ;[415148 + i, 519888].forEach((value, n) => p.set([value >> 12, value >> 4 & 255, value << 4 & 255], n * 3))
  coefficients.forEach((value, n) => n === 0 || n === 3 ? v.setUint16(6 + n * 2, value, true) : v.setInt16(6 + n * 2, value, true))
  frame(2, i + 1, i * 200, p, 10000, 10)
}
let wire = 0
const records = pending.sort((a, b) => a.ready - b.ready).map(row => { wire = Math.max(wire, row.ready) + 128 * 10 / 115.2; return { receivedAtMs: Math.round(wire * 1000) / 1000, hex: row.hex } })
const anchor = { bootId: String(boot), boardUs: '1000000', localMs: 0, uncertaintyUs: 0, driftPpm: 200, source: 'fixture' }
const dataset = {
  version: 1, evidence: 'synthetic-register-fixture', provenance: 'Analytic stationary-then-Euler motion and constant NED velocity. Independent raw quantization/CRC. Scripted latitude-zero location, known synthetic GNSS epoch. No physical capture or alignment.',
  anchor, anchors: [{ receivedAtMs: 4000, anchor: { ...anchor, localMs: 4000, boardUs: '5000000' } }],
  calibrations: {
    imu: { id: 'estimator-frd-fixture', provenance: 'fixture', axes: [1, 2, 3], referenceC: 25, minC: -20, maxC: 60, accelBias: [0, 0, 0], gyroBias: [0, 0, 0], accelScale: [1, 1, 1], gyroScale: [1, 1, 1], accelTempSlope: [0, 0, 0], gyroTempSlope: [0, 0, 0], accelNoiseStd: [0.02, 0.02, 0.02], gyroNoiseStd: [0.001, 0.001, 0.001] },
    barometer: { id: 'estimator-pressure-fixture', provenance: 'fixture', offsetPa: 0, tempSlopePaPerC: 0, referenceC: 25, minC: -20, maxC: 60, noiseStdPa: 2 },
  }, records,
}
await Bun.write(new URL('./motion-v1.json', import.meta.url), `${JSON.stringify(dataset, null, 2)}\n`)
await Bun.write(new URL('./truth-v1.json', import.meta.url), `${JSON.stringify({ evidence: 'analytic-synthetic-truth', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, truth }, null, 2)}\n`)
