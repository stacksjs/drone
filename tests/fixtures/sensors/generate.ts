/** Independent fixture writer: DataView + Bun's CRC32, with no imports from the application codec. */
const boot = 0x1122334455667788n
const coefficients = [27504, 26435, -1000, 36477, -10685, 3024, 2855, 140, -7, 15500, -14600, 6000]
const pending: { readyMs: number, packet: Uint8Array, order: number }[] = []
function packet(kind: number, sequence: number, atMs: number, payload: Uint8Array, uncertainty: number, readMs: number) {
  const bytes = new Uint8Array(128), view = new DataView(bytes.buffer)
  bytes.set([68, 83, 1, kind]); view.setUint32(4, sequence, true); view.setBigUint64(8, boot, true)
  view.setBigUint64(16, 1000000n + BigInt(atMs * 1000), true); view.setBigUint64(24, 1000000n + BigInt(Math.round((atMs + readMs) * 1000)), true)
  view.setUint32(32, 9, true); view.setUint16(36, kind, true); view.setUint16(38, payload.length, true); view.setUint32(40, uncertainty, true)
  bytes.set(payload, 44); view.setUint32(124, Bun.hash.crc32(bytes.subarray(0, 124)), true)
  pending.push({ readyMs: atMs + readMs, packet: bytes, order: pending.length })
}
for (let i = 0; i <= 50; i++) {
  const payload = new Uint8Array(16), v = new DataView(payload.buffer)
  v.setInt16(2, i % 5, false); v.setInt16(6, 2048, false); payload[14] = 6; payload[15] = 6
  packet(1, i + 1, i * 20, payload, 2000, 0.1)
}
for (let i = 0; i <= 10; i++) {
  const payload = new Uint8Array(30), v = new DataView(payload.buffer)
  const raw = [415148 + i, 519888]
  raw.forEach((value, n) => payload.set([value >> 12, value >> 4 & 255, value << 4 & 255], n * 3))
  coefficients.forEach((value, n) => n === 0 || n === 3 ? v.setUint16(6 + n * 2, value, true) : v.setInt16(6 + n * 2, value, true))
  packet(2, i + 1, i * 100, payload, 10000, 10)
}
for (let i = 0; i < 2; i++) {
  const payload = new Uint8Array(80), v = new DataView(payload.buffer)
  v.setUint32(0, 1000000 + i * 1000, true); payload[11] = 7; payload[20] = 3; payload[21] = 1; payload[23] = 12
  v.setInt32(32, 100000, true); v.setInt32(36, 70000, true); v.setUint32(40, 1500, true); v.setUint32(44, 2500, true)
  v.setInt32(48, 1000, true); v.setInt32(52, 2000, true); v.setInt32(56, -500, true); v.setUint32(68, 50, true)
  packet(3, i + 1, i * 1000, payload, 0xFFFFFFFF, 9)
}
let wireMs = 0
const records = pending.sort((a, b) => a.readyMs - b.readyMs || a.order - b.order).map(item => {
  wireMs = Math.max(wireMs, item.readyMs) + 128 * 10 / 115.2
  return { receivedAtMs: Math.round(wireMs * 1000) / 1000, hex: Buffer.from(item.packet).toString('hex') }
})
const dataset = {
  version: 1, evidence: 'synthetic-register-fixture',
  provenance: 'Scripted register values, independent DataView/Bun CRC32. No physical sensor or real location capture. UART serialization is modeled at 115200 8N1.',
  anchor: { bootId: boot.toString(), boardUs: '1000000', localMs: 0, uncertaintyUs: 0, driftPpm: 200, source: 'fixture' },
  calibrations: {
    imu: { id: 'fixture-mount-frd-v1', provenance: 'fixture', axes: [1, -2, -3], referenceC: 25, minC: -20, maxC: 60, accelBias: [0, 0, 0], gyroBias: [0, 0, 0], accelScale: [1, 1, 1], gyroScale: [1, 1, 1], accelTempSlope: [0.01, 0, 0], gyroTempSlope: [0, 0.001, 0], accelNoiseStd: [0.02, 0.03, 0.04], gyroNoiseStd: [0.001, 0.002, 0.003] },
    barometer: { id: 'fixture-pressure-v1', provenance: 'fixture', offsetPa: 0, tempSlopePaPerC: 0, referenceC: 25, minC: -20, maxC: 60, noiseStdPa: 2 },
  }, records,
}
await Bun.write(new URL('./bench-v1.json', import.meta.url), `${JSON.stringify(dataset, null, 2)}\n`)
