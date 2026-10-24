import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runBoundedHostProcess } from '../resources/functions/host/process'

const args = process.argv.slice(2)
if (args.length !== 2) throw new Error('Usage: qualify-cargo-fleet-cli <binary> <new-output-directory>')
const source = resolve(args[0]!), output = resolve(args[1]!)
await mkdir(output, { mode: 0o700 })
const binary = join(output, 'drone')
await copyFile(source, binary); await chmod(binary, 0o755)
const hash = (raw: Uint8Array) => new Bun.CryptoHasher('sha256').update(raw).digest('hex')
const rows: Record<string, unknown>[] = []
for (const [scenario, status, owner, massKg, custody] of [
  ['nominal', 'completed', 'final-parcel-actor', 1.5, 'received'],
  ['receiver-primary-link-loss', 'completed', 'final-parcel-actor', 1.5, 'received'],
  ['receiver-both-links-loss', 'unqualified', 'station-actor', 1.5, 'rejected'],
  ['receiver-host-loss-before-intake', 'unqualified', 'station-actor', 1.5, 'uncertain'],
  ['intake-receipt-loss', 'unqualified', 'receiver-body', 1.6, 'uncertain'],
  ['receiver-joint-shift-before-intake', 'unqualified', 'loose-parcel', 1.5, 'rejected'],
  ['receiver-navigation-loss-during-rail', 'unqualified', 'station-actor', 1.5, 'rejected'],
  ['source-kill-after-station-receipt', 'unqualified', 'final-parcel-actor', 1.5, 'received'],
  ['receiver-kill-after-intake', 'unqualified', 'receiver-body', 1.6, 'uncertain'],
  ['receiver-pad-motion-during-rail', 'unqualified', 'station-actor', 1.5, 'rejected'],
  ['receiver-containment-breach-after-intake-receipt', 'unqualified', 'receiver-body', 1.6, 'received'],
] as const) {
  const r = await runBoundedHostProcess([binary, 'cargo:fleet', '--scenario', scenario], { cwd: output, timeoutMs: 30000, stdoutBytes: 16384, stderrBytes: 1024, strictUtf8: true, label: 'Compiled cargo fleet ' + scenario })
  const bytes = Buffer.from(r.stdout, 'utf8')
  await Bun.write(join(output, scenario + '.stdout'), bytes); await Bun.write(join(output, scenario + '.stderr'), r.stderr)
  if (r.exitCode !== (status === 'completed' ? 0 : 2) || r.stderr !== '' || !r.stdout.endsWith('\n') || r.stdout.split('\n').length !== 2) throw new Error('Unqualified copied fleet command: ' + scenario)
  const s = JSON.parse(r.stdout), receiverDelivered = owner === 'final-parcel-actor'
  if (s.evidence !== 'owned-cargo-fleet-simulation' || s.scenario !== scenario || s.status !== status || s.physicalFlightEnabled !== false || s.boardOutputsInhibited !== true || s.identityAuthenticated !== false
    || s.ownership.owner !== owner || s.ownership.initialMassKg !== 3.1 || s.ownership.finalMassKg !== 3.1 || s.ownership.maximumMassErrorKg > 1e-12 || s.receiver.finalLoad.totalMassKg !== massKg || s.receiver.intake.outcome !== custody
    || s.source.scope.bootId !== '101' || s.source.scope.sessionId !== '201' || s.receiver.scope.bootId !== '102' || s.receiver.scope.sessionId !== '202'
    || s.source.status !== (scenario === 'source-kill-after-station-receipt' ? 'blocked' : 'completed') || s.source.delivery.outcome !== 'received' || s.receiver.delivery.outcome !== (receiverDelivered ? 'received' : 'not-released')) throw new Error('Unqualified copied fleet facts: ' + scenario)
  for (const v of [s.source, s.receiver]) if (v.board.physicalActuationEnabled !== false || JSON.stringify(v.board.actuators) !== '[0,0,0,0]' || v.board.expiresAtMs !== null || v.energy.evidence !== 'declared-mission-power-budget' || v.energy.measured !== false || v.energy.electricalModel !== false || v.energy.marginAboveReserveWh <= 0) throw new Error('Unqualified copied fleet authority/budget: ' + scenario)
  if (receiverDelivered && (s.transfer.intake.outcome !== 'attached' || s.transfer.intake.massBeforeKg !== 1.5 || s.transfer.intake.massAfterKg !== 1.6 || s.transfer.intake.receiverScope.sessionId !== '202' || s.transfer.intake.atMs >= s.receiver.intake.acknowledgedAtMs || s.transfer.stationDeparture.atMs <= s.transfer.sourceRelease.atMs + 1000 || s.station.ownedMassKg !== 0 || s.recipient.ownedMassKg !== .1 || s.recipient.phase !== 'held')) throw new Error('Unqualified copied physical transfer: ' + scenario)
  if (scenario === 'receiver-primary-link-loss' && (s.receiver.links.selectedSource !== 'backup' || s.receiver.links.latchedLoss)) throw new Error('Unqualified copied backup continuation')
  if (scenario === 'receiver-both-links-loss' && (!s.receiver.links.latchedLoss || s.station.phase !== 'cancelled' || s.receiver.status !== 'blocked')) throw new Error('Unqualified copied link expiry')
  if (scenario === 'receiver-host-loss-before-intake' && (s.transfer.intake !== null || s.receiver.status !== 'host-lost' || s.receiver.board.fault !== 'output-lease-expired' || s.faultInjection.triggeredAtMs !== s.receiver.intake.grantedAtMs + 4 || s.station.ownedMassKg !== .1)) throw new Error('Unqualified copied host grant gap')
  if (scenario === 'intake-receipt-loss' && (s.receiver.missionReason !== 'payload-diversion-landed' || s.receiver.payloadFailure.reason !== 'uncertain' || s.receiver.intake.receiptCapturedAtMs !== null || s.transfer.finalRelease !== null)) throw new Error('Unqualified copied lost receipt')
  if (scenario === 'receiver-joint-shift-before-intake' && (s.transfer.intake.outcome !== 'refused' || s.receiver.payloadFailure.reason !== 'rejected' || s.loose.ownedMassKg !== .1 || s.loose.phase !== 'held' || s.loose.parcel.positionM[2] !== 0 || s.loose.impact.atMs <= s.transfer.intake.atMs)) throw new Error('Unqualified copied stale joint')
  if (scenario === 'receiver-navigation-loss-during-rail' && (s.receiver.fault !== 'estimator-loss' || s.station.phase !== 'cancelled' || s.station.ownedMassKg !== .1 || s.transfer.intake !== null || s.faultInjection.anchoredAtMs !== s.station.startedAtMs || s.faultInjection.triggeredAtMs !== s.station.startedAtMs + 4)) throw new Error('Unqualified copied navigation loss')
  if (scenario === 'source-kill-after-station-receipt' && (s.receiver.status !== 'completed' || s.faultInjection.anchoredAtMs !== s.source.delivery.acknowledgedAtMs || s.faultInjection.triggeredAtMs !== s.faultInjection.anchoredAtMs + 4 || s.transfer.intake.atMs <= s.faultInjection.triggeredAtMs)) throw new Error('Unqualified copied source kill')
  if (scenario === 'receiver-kill-after-intake' && (s.transfer.intake.outcome !== 'attached' || s.faultInjection.anchoredAtMs !== s.transfer.intake.atMs || s.faultInjection.triggeredAtMs !== s.transfer.intake.atMs + 4 || s.receiver.intake.receiptCapturedAtMs !== null || s.receiver.intake.acknowledgedAtMs !== null || s.transfer.finalRelease !== null)) throw new Error('Unqualified copied receiver kill')
  if (scenario === 'receiver-pad-motion-during-rail' && (s.receiver.fault !== 'material-receive-interlocks' || s.station.phase !== 'cancelled' || s.station.ownedMassKg !== .1 || s.transfer.intake !== null || JSON.stringify(s.faultInjection.forceN) !== '[4,0,0]')) throw new Error('Unqualified copied pad motion')
  if (scenario === 'receiver-containment-breach-after-intake-receipt' && (s.receiver.fault !== 'mission-fence-breach' || Math.hypot(s.receiver.finalPositionM[0], s.receiver.finalPositionM[1]) <= 12 || s.faultInjection.anchoredAtMs !== s.receiver.intake.acknowledgedAtMs || s.faultInjection.triggeredAtMs !== s.faultInjection.anchoredAtMs + 4 || JSON.stringify(s.faultInjection.forceN) !== '[8,0,0]' || s.faultInjection.forceRampMs !== 2000 || s.transfer.finalRelease !== null)) throw new Error('Unqualified copied containment')
  rows.push({ scenario, exit: r.exitCode, status, owner, receiverMassKg: massKg, custody, stdoutBytes: bytes.length, stdoutSha256: hash(bytes) })
  console.log(scenario + ' PASS')
}
const operatorRows: Record<string, unknown>[] = []
for (const name of ['cancel', 'cancel-resume', 'cancel-after-grant', 'resume-after-navigation-loss']) {
  const r = await runBoundedHostProcess([binary, 'cargo:fleet-control', '--case', name], { cwd: output, timeoutMs: 30000, stdoutBytes: 16384, stderrBytes: 1024, strictUtf8: true, label: 'Compiled cargo fleet control ' + name })
  const bytes = Buffer.from(r.stdout, 'utf8')
  await Bun.write(join(output, 'operator-' + name + '.stdout'), bytes); await Bun.write(join(output, 'operator-' + name + '.stderr'), r.stderr)
  const completed = name === 'cancel-resume', s = JSON.parse(r.stdout)
  if (r.exitCode !== (completed ? 0 : 2) || r.stderr !== '' || !r.stdout.endsWith('\n') || r.stdout.split('\n').length !== 2
    || s.evidence !== 'owned-cargo-fleet-simulation' || s.operatorCase !== name || s.status !== (completed ? 'completed' : 'unqualified') || s.physicalFlightEnabled !== false || s.boardOutputsInhibited !== true || s.identityAuthenticated !== false
    || s.operator.identityAuthenticated !== false || !s.operator.contextId || s.operator.events[0]?.action !== 'cancel' || s.operator.events[0]?.outcome !== 'accepted' || s.operator.events[0]?.sequence !== 1
    || s.ownership.finalMassKg !== 3.1 || s.ownership.maximumMassErrorKg > 1e-12 || s.receiver.scope.bootId !== '102' || s.receiver.scope.sessionId !== '202') throw new Error('Unqualified copied operator report: ' + name)
  for (const v of [s.source, s.receiver]) if (v.board.physicalActuationEnabled !== false || JSON.stringify(v.board.actuators) !== '[0,0,0,0]' || v.board.expiresAtMs !== null) throw new Error('Unqualified copied operator output inhibition: ' + name)
  if (completed) {
    const resume = s.station.resumptions?.[0]
    if (s.operator.events.length !== 2 || s.operator.events[1].action !== 'resume' || s.operator.events[1].outcome !== 'accepted' || s.operator.events[1].sequence !== 2 || !resume || s.station.resumptions.length !== 1
      || resume.atMs - resume.stoppedAtMs < 1000 || s.operator.events[1].atMs !== resume.atMs || resume.cancelRequestedAtMs !== s.operator.events[0].atMs
      || s.ownership.owner !== 'final-parcel-actor' || s.receiver.intake.outcome !== 'received' || s.receiver.delivery.outcome !== 'received' || s.transfer.intake.massBeforeKg !== 1.5 || s.transfer.intake.massAfterKg !== 1.6
      || s.transfer.intake.atMs <= resume.atMs || s.transfer.intake.atMs >= s.receiver.intake.acknowledgedAtMs || s.recipient.ownedMassKg !== .1 || s.ownership.transitions.length !== 3) throw new Error('Unqualified copied operator recovery: ' + name)
  }
  else {
    if (s.ownership.owner !== 'station-actor' || s.station.phase !== 'cancelled' || s.station.ownedMassKg !== .1 || s.station.resumptions !== undefined || s.transfer.intake !== null || s.transfer.finalRelease !== null || s.receiver.finalLoad.totalMassKg !== 1.5) throw new Error('Unqualified copied operator retention: ' + name)
    if (name === 'cancel' && s.operator.events.length !== 1) throw new Error('Unexpected copied recovery')
    if (name !== 'cancel' && (s.operator.events.length !== 2 || s.operator.events[1].action !== 'resume' || s.operator.events[1].outcome !== 'refused' || s.operator.events[1].sequence !== 2
      || s.operator.events[1].reason !== (name === 'cancel-after-grant' ? 'intake-already-attempted' : 'recovery-authority-unavailable'))) throw new Error('Unqualified copied refused recovery: ' + name)
    if (name === 'cancel-after-grant' && s.receiver.intake.outcome !== 'uncertain') throw new Error('Lost attempted intake uncertainty')
    if (name === 'resume-after-navigation-loss' && s.receiver.fault !== 'estimator-loss') throw new Error('Lost operator authority failure')
  }
  operatorRows.push({ case: name, exit: r.exitCode, status: s.status, owner: s.ownership.owner, stdoutBytes: bytes.length, stdoutSha256: hash(bytes) })
  console.log('operator-' + name + ' PASS')
}
await Bun.write(join(output, 'receipt.json'), JSON.stringify({ evidence: 'copied-cargo-fleet-cli-consistency', binarySha256: hash(new Uint8Array(await Bun.file(binary).arrayBuffer())), physicalFlightEnabled: false, identityAuthenticated: false, rows, operatorRows }, null, 2))
