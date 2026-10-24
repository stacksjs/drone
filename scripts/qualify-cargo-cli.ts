import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runBoundedHostProcess } from '../resources/functions/host/process'

const args = process.argv.slice(2)
if (args.length !== 2) throw new Error('Usage: qualify-cargo-cli <binary> <new-output-directory>')
const source = resolve(args[0]!), output = resolve(args[1]!)
await mkdir(output, { mode: 0o700 })
const binary = join(output, 'drone')
await copyFile(source, binary)
await chmod(binary, 0o755)
const request = join(output, 'request.json')
await copyFile(new URL('../examples/cargo-delivery.json', import.meta.url), request)
const cases: [string, string, string][] = [
  ['nominal', 'completed', 'received'], ['recipient-absent', 'diverted', 'not-released'], ['site-blocked', 'diverted', 'not-released'],
  ['mechanism-jam', 'diverted', 'not-released'], ['receipt-loss', 'diverted', 'uncertain'], ['foreign-receipt', 'diverted', 'uncertain'],
  ['primary-link-loss', 'completed', 'received'], ['both-links-loss', 'blocked', 'not-released'], ['authority-containment', 'blocked', 'not-released'],
  ['diversion-position-loss', 'blocked', 'not-released'], ['diversion-kill', 'blocked', 'not-released'],
  ['position-loss', 'blocked', 'not-released'], ['imu-loss', 'blocked', 'not-released'], ['vehicle-sensor-loss', 'blocked', 'not-released'],
  ['rc-override', 'blocked', 'not-released'], ['kill', 'blocked', 'not-released'], ['host-loss', 'host-lost', 'not-released'],
  ['after-release-host-loss', 'host-lost', 'uncertain'], ['after-release-position-loss', 'blocked', 'uncertain'], ['after-release-imu-loss', 'blocked', 'uncertain'],
  ['after-release-vehicle-sensor-loss', 'blocked', 'uncertain'], ['after-release-rc-override', 'blocked', 'uncertain'], ['after-release-kill', 'blocked', 'uncertain'], ['after-release-both-links-loss', 'blocked', 'uncertain'],
  ['after-receipt-host-loss', 'host-lost', 'received'], ['after-receipt-kill', 'blocked', 'received'], ['after-receipt-position-loss', 'blocked', 'received'],
]
const rows: Record<string, unknown>[] = []
const hash = (bytes: ArrayBuffer | Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
async function run(name: string, command: string[], expectedExit: number, scenario: string, status: string, custody: string, configured: boolean) {
  const result = await runBoundedHostProcess([binary, ...command], { cwd: output, timeoutMs: 30000, stdoutBytes: 16384, stderrBytes: 1024, strictUtf8: true, label: 'Compiled cargo command ' + name })
  const stdout = Buffer.from(result.stdout, 'utf8'), stderr = Buffer.from(result.stderr, 'utf8'), exit = result.exitCode
  await Bun.write(join(output, name + '.stdout'), stdout)
  await Bun.write(join(output, name + '.stderr'), stderr)
  if (exit !== expectedExit || stderr.byteLength !== 0 || stdout.byteLength > 16384) throw new Error('Unqualified compiled cargo command: ' + name)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(stdout)
  if (!text.endsWith('\n') || text.split('\n').length !== 2) throw new Error('Invalid compiled cargo wire: ' + name)
  const report = JSON.parse(text)
  if (report.evidence !== 'owned-cargo-delivery-simulation' || report.scenario !== scenario || report.status !== status || report.delivery.outcome !== custody || report.demonstrationMatched !== true
    || report.physicalFlightEnabled !== false || report.identityAuthenticated !== false || report.board.physicalActuationEnabled !== false || report.board.expiresAtMs !== null || JSON.stringify(report.board.actuators) !== '[0,0,0,0]'
    || report.landingContact !== ['completed', 'diverted'].includes(status) || report.authority.hostAvailable !== (status !== 'host-lost') || report.energy.measured !== false || report.energy.electricalModel !== false || report.energy.marginAboveReserveWh <= 0) throw new Error('Invalid compiled cargo outcome: ' + name)
  if (custody === 'received' && (![report.delivery.receiptCapturedAtMs, report.delivery.mechanismCapturedAtMs, report.delivery.requestedAtMs, report.delivery.acknowledgedAtMs].every(value => Number.isSafeInteger(value) && value >= 0) || !(report.delivery.receiptCapturedAtMs >= report.delivery.mechanismCapturedAtMs && report.delivery.mechanismCapturedAtMs > report.delivery.requestedAtMs && report.delivery.receiptCapturedAtMs <= report.delivery.acknowledgedAtMs))
    || custody !== 'received' && report.delivery.receiptCapturedAtMs !== null) throw new Error('Invalid compiled cargo custody: ' + name)
  if (scenario.startsWith('after-') && (!report.faultInjection || ![report.faultInjection.triggeredAtMs, report.faultInjection.anchoredAtMs, report.faultInjection.sourceCapturedAtMs, report.faultInjection.finalPhysicalAtMs].every(value => Number.isSafeInteger(value) && value >= 0) || report.faultInjection.triggeredAtMs !== report.faultInjection.anchoredAtMs + 20 || report.faultInjection.sourceCapturedAtMs > report.faultInjection.anchoredAtMs || report.faultInjection.sourceCapturedAtMs < report.release.atMs || report.faultInjection.eventId !== report.release.eventId || report.faultInjection.finalPhysicalAtMs < report.faultInjection.triggeredAtMs + 1000 || report.faultInjection.independentTailMs !== 1000 || report.parcel.onSurface !== true)) throw new Error('Invalid compiled cargo phase: ' + name)
  if (configured && (report.configuration.id !== 'operator-cargo-route' || report.load.initial.totalMassKg !== 1.65 || report.model.loadMassKg !== .15 || report.model.loadForwardM !== -.04)) throw new Error('Invalid compiled cargo declaration: ' + name)
  if (scenario === 'primary-link-loss' && (report.links.selectedSource !== 'backup' || report.links.latchedLoss) || scenario.endsWith('both-links-loss') && !report.links.latchedLoss) throw new Error('Invalid compiled cargo link evidence: ' + name)
  rows.push({ name, command, exit, scenario, status, custody, stdoutBytes: stdout.byteLength, stdoutSha256: hash(stdout), configured })
  console.log(name + ' PASS')
}
for (const [scenario, status, custody] of cases) await run(scenario, ['cargo:deliver', '--scenario', scenario], 0, scenario, status, custody, false)
for (const [scenario, status, custody] of cases.filter(([name]) => ['nominal', 'site-blocked', 'after-release-host-loss', 'after-receipt-kill'].includes(name))) {
  await run('configured-' + scenario, ['cargo:mission', request, '--scenario', scenario], scenario === 'nominal' ? 0 : 2, scenario, status, custody, true)
}
await Bun.write(join(output, 'receipt.json'), JSON.stringify({ evidence: 'copied-cargo-cli-consistency', binarySha256: hash(await Bun.file(binary).arrayBuffer()), requestSha256: hash(await Bun.file(request).arrayBuffer()), physicalFlightEnabled: false, identityAuthenticated: false, rows }, null, 2))
