/** Controlled timestamps over real fragmented IPC; never hardware evidence. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { payloadFixtureJpeg } from '../../../resources/functions/drone/payloads/replay'

const scenario = process.argv[2], trace = process.argv[3]!, sessionId = process.argv[process.argv.indexOf('--session') + 1]!, bootId = 'controlled-clock-boot'
if (!['positive', 'sync-rtt', 'future-ack', 'combined-boundary', 'combined-over'].includes(scenario!)) throw new Error('Unknown controlled clock scenario')
async function send(value: unknown) {
  const data = `${JSON.stringify(value)}\n`
  process.stdout.write(data.slice(0, 41))
  await new Promise<void>(resolve => setImmediate(resolve))
  process.stdout.write(data.slice(41))
}
await send({ version: 1, kind: 'hello', sessionId, bootId, deviceId: 'controlled-clock-process', evidence: 'fixture', width: 8, height: 8 })
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line)
  if (c.sessionId !== sessionId || c.bootId !== bootId || ![1, 2].includes(c.sequence) || (c.sequence === 2 && scenario !== 'positive') || !['sync', 'capture'].includes(c.kind)) throw new Error('Unexpected controlled clock command')
  appendFileSync(trace, `${JSON.stringify({ kind: c.kind, sequence: c.sequence })}\n`)
  if (c.kind === 'sync') {
    await send({ version: 1, kind: 'sync', sessionId, bootId, sequence: c.sequence, monotonicMs: c.sequence === 1 ? 200 : 220 })
    continue
  }
  const combined = scenario === 'combined-boundary' || scenario === 'combined-over'
  if (scenario === 'sync-rtt' || c.notBeforeMonotonicMs !== (c.sequence === 1 ? 200 : 220) || c.deadlineMonotonicMs !== (combined ? 2192 : c.sequence === 1 ? 2196 : 2216)) throw new Error('Unexpected controlled capture clock mapping')
  const timestamp = scenario === 'future-ack' ? 209 : combined ? 202 : c.sequence === 1 ? 204 : 224
  await send({ version: 1, kind: 'capture', sessionId, bootId, sequence: c.sequence, capturedMonotonicMs: timestamp, acknowledgedMonotonicMs: timestamp, clockUncertaintyMs: scenario === 'combined-over' ? 1.25 : combined ? 1 : 0.5, exposureTimeUs: 1000, width: 8, height: 8, jpeg: payloadFixtureJpeg().toBase64() })
}
