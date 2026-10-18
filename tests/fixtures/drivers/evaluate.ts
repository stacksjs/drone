import { runDriverProtocolBench } from '../../../resources/functions/drone/drivers/bench'
const results = []
for (const driver of ['ardupilot', 'px4'] as const) {
  for (const signed of [false, true]) results.push(await runDriverProtocolBench({ driver, signed, dropFirstAck: true }))
}
const destination = process.argv[2] ?? new URL('../../../docs/driver-protocol-evidence.json', import.meta.url).pathname
await Bun.write(destination, `${JSON.stringify({ evidence: 'scripted-loopback-protocol-conformance', firmwareSitlValidated: false, hardwareValidated: false, results }, (key, value) => typeof value === 'bigint' ? String(value) : value, 2)}\n`)
