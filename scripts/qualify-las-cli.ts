import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runBoundedHostProcess } from '../resources/functions/host/process'
import { primaryLasBytes, primaryLasDeclaration, primaryLasMeasurement, primaryLasRecordFormat, primaryLasSha256, primaryLasVerticalCrs } from '../tests/fixtures/volumes/las'

const args = process.argv.slice(2)
if (args.length !== 2) throw new Error('Usage: qualify-las-cli <binary> <new-output-directory>')
const source = resolve(args[0]!), output = resolve(args[1]!)
await mkdir(output, { mode: 0o700 })
const binary = join(output, 'drone'), sha = (bytes: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
await copyFile(source, binary); await chmod(binary, 0o755)
await Bun.write(join(output, 'source.las'), primaryLasBytes())
await Bun.write(join(output, 'declaration.json'), primaryLasDeclaration())
await Bun.write(join(output, 'measurement.json'), JSON.stringify(primaryLasMeasurement()))
const rows: { name: string, exit: number, stdoutBytes: number, stdoutSha256: string, stderrBytes: number, stderrSha256: string }[] = []
async function run(name: string, args: string[], exit = 0) {
  const r = await runBoundedHostProcess([binary, ...args], { cwd: output, timeoutMs: 30000, stdoutBytes: 65536, stderrBytes: 2048, strictUtf8: true, label: 'Copied LAS ' + name })
  await Bun.write(join(output, name + '.stdout'), r.stdout); await Bun.write(join(output, name + '.stderr'), r.stderr)
  if (r.exitCode !== exit || exit === 0 && r.stderr !== '' || exit !== 0 && r.stdout !== '') throw new Error('Unqualified copied LAS exit: ' + name)
  rows.push({ name, exit, stdoutBytes: Buffer.byteLength(r.stdout), stdoutSha256: sha(r.stdout), stderrBytes: Buffer.byteLength(r.stderr), stderrSha256: sha(r.stderr) })
  return exit === 0 ? JSON.parse(r.stdout) : r
}
const common = ['--format', 'las', '--metadata', join(output, 'declaration.json'), '--measurement', join(output, 'measurement.json')]
const first = await run('import', ['volumes:import', join(output, 'source.las'), ...common, '--output', join(output, 'dataset')])
if (first.report.aboveBaseM3 !== 18 || first.report.coveredAreaM2 !== 3 || first.report.uncoveredAreaM2 !== 1 || first.report.fullBoundarySignedM3 !== null || first.report.physicalAccuracyVerified !== false
  || first.report.uncertainty.overallAccuracyBoundM3 !== null || first.sourceProcessing.sourceSha256 !== primaryLasSha256 || first.sourceProcessing.selectedPointCount !== 5 || first.sourceProcessing.cells !== undefined) throw new Error('Unqualified copied LAS primary facts')
const manifest = JSON.parse(await readFile(join(output, 'dataset/manifest.json'), 'utf8'))
for (const file of manifest.files) {
  const bytes = await readFile(join(output, 'dataset', file.path))
  if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error('Unqualified copied LAS dataset hash')
}
const processing = JSON.parse(await readFile(join(output, 'dataset/source.gridding.json'), 'utf8'))
if (manifest.originalSourceSha256 !== primaryLasSha256 || manifest.sourceProcessing.format !== 'las' || sha(await readFile(join(output, 'dataset/source.las'))) !== primaryLasSha256
  || JSON.stringify(processing.cells.map((c: { meanM: number | null }) => c.meanM)) !== '[3,6,9,null]' || processing.excluded.withheld !== 1 || processing.excluded.classification !== 1 || processing.excluded.outsideGrid !== 1) throw new Error('Unqualified copied LAS processing evidence')
const replay = await run('replay', ['volumes:process', join(output, 'dataset/request.json')])
const asc = await run('asc', ['volumes:import', join(output, 'dataset/surface.asc'), '--format', 'asc', '--metadata', join(output, 'dataset/surface.metadata.json'), '--measurement', join(output, 'measurement.json')])
if (JSON.stringify(replay.report) !== JSON.stringify(first.report) || JSON.stringify(asc.report) !== JSON.stringify(first.report)) throw new Error('Unqualified copied LAS replay')
for (const format of [1, 2, 3] as const) {
  const bytes = primaryLasRecordFormat(format, 1), d = JSON.parse(primaryLasDeclaration())
  d.metadata.provenance.sourceSha256 = sha(bytes)
  await Bun.write(join(output, 'format.las'), bytes); await Bun.write(join(output, 'format.json'), JSON.stringify(d))
  const report = await run('format-' + format, ['volumes:import', join(output, 'format.las'), '--format', 'las', '--metadata', join(output, 'format.json'), '--measurement', join(output, 'measurement.json')])
  if (report.report.aboveBaseM3 !== 18 || report.sourceProcessing.format !== format || report.sourceProcessing.gps.type !== (format === 2 ? 'absent' : 'adjusted-standard-seconds')) throw new Error('Unqualified copied LAS record format')
}
const wrong = JSON.parse(primaryLasDeclaration()); wrong.metadata.provenance.sourceSha256 = '0'.repeat(64)
await Bun.write(join(output, 'wrong.json'), JSON.stringify(wrong))
const refused = await run('wrong-digest', ['volumes:import', join(output, 'source.las'), '--format', 'las', '--metadata', join(output, 'wrong.json'), '--measurement', join(output, 'measurement.json')], 1)
if (refused.stderr.trim() !== 'las-source-sha256-mismatch') throw new Error('Unqualified copied LAS digest refusal')
for (const [code, accepted] of [[5703, true], [5702, false], [5715, false]] as const) {
  const bytes = primaryLasVerticalCrs(code, true), d = JSON.parse(primaryLasDeclaration())
  d.metadata.provenance.sourceSha256 = sha(bytes); d.metadata.reference.verticalDatum.id = 'EPSG:' + code
  await Bun.write(join(output, 'vertical.las'), bytes); await Bun.write(join(output, 'vertical.json'), JSON.stringify(d))
  const result = await run('vertical-' + code, ['volumes:import', join(output, 'vertical.las'), '--format', 'las', '--metadata', join(output, 'vertical.json'), '--measurement', join(output, 'measurement.json')], accepted ? 0 : 1)
  if (accepted ? result.report.aboveBaseM3 !== 18 || result.sourceProcessing.verticalReference.embeddedCrs !== 'EPSG:5703' || result.sourceProcessing.verticalReference.coordinateTransformPerformed !== false || result.sourceProcessing.verticalReference.datumVerified !== false : result.stderr !== 'las-surface-input\n') throw new Error('Unqualified copied LAS vertical interpretation')
}
for (const kind of ['declaration', 'measurement', 'output']) {
  const unavailable = join(output, 'PRIVATE_' + kind.toUpperCase())
  if (kind === 'output') await Bun.write(unavailable, 'PRIVATE_EXISTING_FILE')
  const result = await run('private-' + kind, ['volumes:import', join(output, 'source.las'), '--format', 'las', '--metadata', kind === 'declaration' ? unavailable : join(output, 'declaration.json'), '--measurement', kind === 'measurement' ? unavailable : join(output, 'measurement.json'), '--output', kind === 'output' ? unavailable : join(output, 'PRIVATE_UNPUBLISHED_DATASET')], 1)
  if (result.stderr !== 'las-import-unavailable\n' || result.stderr.includes('PRIVATE') || await Bun.file(join(output, 'PRIVATE_UNPUBLISHED_DATASET/manifest.json')).exists()) throw new Error('Unqualified copied LAS filesystem privacy')
  if (kind === 'output' && await Bun.file(unavailable).text() !== 'PRIVATE_EXISTING_FILE') throw new Error('Copied LAS import changed an existing output')
}
await Bun.write(join(output, 'receipt.json'), JSON.stringify({ evidence: 'copied-las-stockpile-cli-v1', binarySha256: sha(new Uint8Array(await Bun.file(binary).arrayBuffer())), sourceSha256: primaryLasSha256, formats: [0, 1, 2, 3], physicalAccuracyVerified: false, acquisitionPerformed: false, classificationVerified: false, rows }, null, 2))
console.log('PASS copied LAS source, four record formats, grid audit, volume replay, vertical interpretation and private refusals')
