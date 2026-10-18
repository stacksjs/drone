/** Local IPC peer, never hardware evidence. Deliberately fragment stdout records. */
import { createInterface } from 'node:readline'
import { payloadFixtureJpeg } from '../../../resources/functions/drone/payloads/replay'
const sessionId = process.argv[process.argv.indexOf('--session') + 1]!, fault = process.argv[2], bootId = 'fixture-boot'
async function send(value: unknown) {
  const data = `${JSON.stringify(value)}\n`
  process.stdout.write(data.slice(0, 41))
  await new Promise<void>(resolve => setImmediate(resolve))
  process.stdout.write(data.slice(41))
}
if (fault === 'ignore-term') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000) }
if (fault === 'no-hello') await Bun.sleep(60000)
if (fault === 'oversize') { process.stdout.write('x'.repeat(750001)); await Bun.sleep(10000) }
else {
  await send({ version: 1, kind: 'hello', sessionId, bootId, deviceId: 'fixture-process', evidence: 'fixture', width: 8, height: 8 })
  for await (const line of createInterface({ input: process.stdin })) {
    const c = JSON.parse(line)
    if (fault === 'exit') process.exit(1)
    if (c.kind === 'sync') {
      if (fault === 'slow-sync') await Bun.sleep(30)
      await send({ version: 1, kind: 'sync', sessionId, bootId, sequence: c.sequence, monotonicMs: Number(process.hrtime.bigint()) / 1000000 })
      continue
    }
    while (Number(process.hrtime.bigint()) / 1000000 < c.notBeforeMonotonicMs) await Bun.sleep(1)
    if (fault === 'ignore-term') {
      await Bun.write(process.argv[3]!, JSON.stringify({ pid: process.pid, phase: 'capture' }))
      continue
    }
    if (fault === 'lost-ack') continue
    const timestamp = Number(process.hrtime.bigint()) / 1000000
    await send({ version: 1, kind: 'capture', sessionId, bootId: fault === 'wrong-boot' ? 'alien' : bootId, sequence: c.sequence, capturedMonotonicMs: fault === 'stale' ? c.notBeforeMonotonicMs - 100 : timestamp, acknowledgedMonotonicMs: timestamp, clockUncertaintyMs: 0.01, exposureTimeUs: 1000, width: 8, height: 8, jpeg: payloadFixtureJpeg().toBase64() })
  }
}
