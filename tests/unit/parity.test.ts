import { expect, test } from 'bun:test'
import inventory from '../../docs/roadmap/upstream-inventory.json'
import issues from '../../docs/roadmap/issues.json'
import audit from '../../docs/parity-audit.json'
import { checkParityAudit } from '../../scripts/parity'

// Public audit decision seam catches false support/provenance claims, not flight equivalence.
test('the retained audit assigns every pinned directory and reports unresolved detail instead of full parity', () => {
  const report = checkParityAudit(inventory, issues, audit as ParityAudit)
  expect(report.errors).toEqual([])
  expect(report.inventoryEntries).toBe(274)
  expect(report.parityComplete).toBe(false)
  expect(report.unclassifiedDimensions).toBeGreaterThan(0)
  expect(report.claimedCases).toBeGreaterThan(0)
})

import type { ParityAudit } from '../../scripts/parity'
import { runParityEvidence } from '../../scripts/parity'
import { compareUpstreamSnapshot, refreshUpstreamSnapshot, verifyParitySources, verifyParityIssueLinks } from '../../scripts/parity-refresh'
import type { UpstreamSnapshot } from '../../scripts/parity-refresh'

const details = () => structuredClone(audit) as ParityAudit

test('missing directory assignments, dangling issue URLs and fabricated reviewed dimensions fail coverage', () => {
  const omitted = details(); omitted.assignments.shift()
  expect(checkParityAudit(inventory, issues, omitted).errors.join()).toContain('Unassigned upstream entry')
  const dangling = structuredClone(inventory); dangling.upstreams[0]!.entries[0]!.issue = 'https://github.com/stacksjs/drone/issues/999'
  expect(checkParityAudit(dangling, issues, details()).errors.join()).toContain('dangling')
  const invented = details(), assignment = invented.assignments.find(a => a.reviewed.length === 0)!
  assignment.reviewed.push('protocols'); assignment.unclassified = assignment.unclassified.filter(d => d !== 'protocols')
  expect(checkParityAudit(inventory, issues, invented).errors.join()).toContain('Reviewed dimension lacks a case')
})

test('claims cannot omit source licensing, pinning, executable tests or known limits', () => {
  for (const defect of ['source', 'test', 'limits', 'pin', 'license'] as const) {
    const a = details(), c = a.cases.find(c => c.evidence.length > 0)!
    if (defect === 'source') c.sources = []
    if (defect === 'test') c.evidence[0]!.testName = 'invented behavior that has never been executed'
    if (defect === 'limits') c.limitations = []
    if (defect === 'pin') a.sources[0]!.revision = 'main'
    if (defect === 'license') a.sources[0]!.license = ''
    expect(checkParityAudit(inventory, issues, a).validAudit).toBe(false)
  }
})

test('scripted peers cannot be promoted to firmware SITL, HIL or vehicle evidence without versions and artifacts', () => {
  for (const kind of ['sitl', 'hil', 'vehicle'] as const) {
    const a = details(); a.cases.find(c => c.evidence.length)!.evidence[0]!.kind = kind
    expect(checkParityAudit(inventory, issues, a).errors.join()).toContain('Missing firmware/environment evidence')
  }
  const a = details(); a.cases.find(c => c.evidence.length)!.evidence[0]!.firmware.status = 'tested'
  expect(checkParityAudit(inventory, issues, a).errors.join()).toContain('Synthetic evidence claims firmware validation')
})

function retainedSnapshot(): UpstreamSnapshot {
  return {
    schemaVersion: 1,
    upstreams: inventory.upstreams.map(u => ({ id: u.id, revision: u.revision, roots: [
      ...u.scope.map(s => ({ path: s.replace(/\/$/, ''), entries: u.entries.filter(e => e.path.startsWith(s)).map(e => ({ path: e.path, treeSha: e.treeSha })) })),
      ...(u.id === 'ardupilot' ? [{ path: '', entries: audit.rootDirectories.filter(r => r.upstream === u.id).map(r => ({ path: r.path, treeSha: audit.vehicleFamilies.find(v => v.path === r.path)?.treeSha ?? 'a'.repeat(40) })) }] : []),
    ] })),
  }
}

test('upstream refresh detects new libraries, removed modules, changed trees and unclassified vehicle roots', () => {
  expect(compareUpstreamSnapshot(inventory, details(), retainedSnapshot()).reviewRequired).toBe(false)
  const candidate = retainedSnapshot(), px = candidate.upstreams[0]!, ap = candidate.upstreams[1]!
  px.roots[0]!.entries.shift()
  px.roots[0]!.entries[0]!.treeSha = 'b'.repeat(40)
  ap.roots[0]!.entries.push({ path: 'libraries/AP_NewHardware', treeSha: 'c'.repeat(40) })
  ap.roots.find(r => r.path === '')!.entries.push({ path: 'ArduNewVehicle', treeSha: 'd'.repeat(40) })
  const comparison = compareUpstreamSnapshot(inventory, details(), candidate)
  expect(comparison.reviewRequired).toBe(true)
  expect(comparison.added).toContain('ardupilot:libraries/AP_NewHardware')
  expect(comparison.added).toContain('ardupilot:ArduNewVehicle')
  expect(comparison.removed).toContain('px4:src/modules/airship_att_control')
  expect(comparison.changed).toContain('px4:src/modules/airspeed_selector')
  candidate.upstreams[0]!.revision = 'f'.repeat(40)
  expect(compareUpstreamSnapshot(inventory, details(), candidate).revisions).toHaveLength(1)
  candidate.upstreams[0]!.roots.pop()
  expect(compareUpstreamSnapshot(inventory, details(), candidate).errors.join()).toContain('Missing snapshot root')
})

// Public refresh seam uses a fake remote HTTP boundary, preserving real pin and directory behavior.
test('refresh resolves revision names once, sends immutable revisions to listings and refuses truncated responses', async () => {
  const calls: string[] = []
  const input = { schemaVersion: 1, upstreams: [{ ...inventory.upstreams[0]!, scope: ['src/modules/'] }] }
  const snapshot = await refreshUpstreamSnapshot(input, { px4: 'v-next' }, async endpoint => {
    calls.push(endpoint)
    return endpoint.includes('/commits/') ? { sha: 'f'.repeat(40) } : [{ type: 'dir', path: 'src/modules/new_module', sha: 'e'.repeat(40) }]
  })
  expect(calls[0]).toEndWith('/commits/v-next')
  expect(calls[1]).toEndWith(`?ref=${'f'.repeat(40)}`)
  expect(snapshot.upstreams[0]!.roots[0]!.entries[0]!.path).toBe('src/modules/new_module')
  await expect(refreshUpstreamSnapshot(input, {}, async endpoint => endpoint.includes('/commits/') ? { sha: 'f'.repeat(40) } : Array.from({ length: 1000 }, () => ({})))).rejects.toThrow('Incomplete upstream listing')
  await expect(refreshUpstreamSnapshot(input, {}, async () => ({ sha: 'main' }))).rejects.toThrow('Unresolved revision')
})

test('source verification detects altered bytes and citations that do not exist at the pinned line', async () => {
  const a = details(), c = a.cases[0]!, s = a.sources.find(s => s.id === c.sources[0]!.source)!
  a.sources = [s]; a.cases = [c]
  const errors = await verifyParitySources(a, inventory, async () => ({ encoding: 'base64', sha: s.blobSha, content: Buffer.from('different upstream source\n').toString('base64') }))
  expect(errors.join()).toContain('Source content changed')
  expect(errors.join()).toContain('Source symbol does not support citation')
})

test('an executable evidence selector that matches zero tests cannot satisfy a capability claim', async () => {
  const a = details(), c = a.cases.find(c => c.evidence.length)!
  c.evidence[0]!.testName = 'parity selector that deliberately matches no behavior'
  a.cases = [c]
  expect((await runParityEvidence(a))[0]!.passed).toBe(false)
}, 60000)


test('a remote issue redirect, deleted issue placeholder or pull request cannot satisfy a roadmap issue link', async () => {
  const url = 'https://github.com/stacksjs/drone/issues/28'
  expect(await verifyParityIssueLinks([{ url }], async () => ({ number: 28, html_url: url, state: 'open' }))).toEqual([])
  expect(await verifyParityIssueLinks([{ url }], async () => ({ number: 29, html_url: url, state: 'closed' }))).toHaveLength(1)
  expect(await verifyParityIssueLinks([{ url }], async () => ({ number: 28, html_url: url, state: 'open', pull_request: {} }))).toHaveLength(1)
})

import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGitHub } from '../../scripts/parity-refresh'

// Public process seam uses a real executable and pipes; it catches byte limits and child cleanup.
async function withFakeGitHub(run: (pidFile: string, env: Record<string, string | undefined>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'drone-parity-gh-'))
  const executable = join(directory, 'gh'), program = join(directory, 'fixture.ts'), config = join(directory, 'bunfig.toml'), pidFile = join(directory, 'child.pid')
  await Bun.write(config, 'preload = []\n')
  await Bun.write(program, `await Bun.write(process.env.PARITY_GH_PID!, String(process.pid))
const mode = process.argv[3]
if (mode === 'valid') console.log(JSON.stringify({ okay: true }))
else if (mode === 'stdout-overflow') { await new Promise<void>(resolve => process.stdout.write(JSON.stringify('😀'.repeat(500001)), () => resolve())); await Bun.sleep(60000) }
else if (mode === 'stderr-overflow') { await new Promise<void>(resolve => process.stderr.write('x'.repeat(65537), () => resolve())); await Bun.sleep(60000) }
else if (mode === 'timeout') { process.on('SIGTERM', () => {}); await Bun.sleep(60000) }
else { console.error('fixture failure'); process.exitCode = 3 }
`)
  const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`
  await Bun.write(executable, `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(`--config=${config}`)} ${quote(program)} "$@"\n`)
  await chmod(executable, 0o700)
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, PARITY_GH_PID: pidFile }
  try { await run(pidFile, env) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('GitHub stdout is bounded by bytes, including multibyte JSON below the old character limit', async () => {
  await withFakeGitHub(async (pidFile, env) => {
    await expect(readGitHub('stdout-overflow', { env })).rejects.toThrow('stdout exceeds byte limit')
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

test('GitHub stderr overflow and a deadline kill the real child and finish pipe cleanup before rejection', async () => {
  await withFakeGitHub(async (pidFile, env) => {
    for (const [mode, message, timeoutMs] of [
      ['stderr-overflow', 'stderr exceeds byte limit', 20000],
      ['timeout', 'timed out', 1000],
    ] as const) {
      await expect(readGitHub(mode, { env, timeoutMs })).rejects.toThrow(message)
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    }
  })
}, 30000)

test('the bounded GitHub process returns valid JSON and retains bounded diagnostics for nonzero exit', async () => {
  await withFakeGitHub(async (pidFile, env) => {
    expect(await readGitHub('valid', { env })).toEqual({ okay: true })
    const successPid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(successPid, 0)).toThrow()
    await expect(readGitHub('failed', { env })).rejects.toThrow('fixture failure')
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })
}, 15000)

import { writeUpstreamSnapshot } from '../../scripts/parity-refresh'

// Public output seam exercises the filesystem race, not an existence-check stand-in.
test('candidate snapshots use exclusive creation so existing files and racing writers cannot be overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-parity-output-'))
  try {
    const output = join(directory, 'candidate.json'), first = retainedSnapshot(), second = retainedSnapshot()
    second.upstreams[0]!.revision = 'b'.repeat(40)
    const race = await Promise.allSettled([writeUpstreamSnapshot(output, first), writeUpstreamSnapshot(output, second)])
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(race.filter(result => result.status === 'rejected')).toHaveLength(1)
    const winner = await readFile(output, 'utf8')
    expect([first, second]).toContainEqual(JSON.parse(winner))
    await expect(writeUpstreamSnapshot(output, first)).rejects.toThrow('Candidate output already exists')
    expect(await readFile(output, 'utf8')).toBe(winner)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})

import { runParityProcess } from '../../scripts/parity-process'

// Public bounded process seam uses a real descendant that holds its parent's stdout open.
test.skipIf(process.platform === 'win32')('a descendant holding inherited pipes cannot extend the parity process deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-parity-descendant-'))
  const config = join(directory, 'bunfig.toml'), parent = join(directory, 'parent.ts'), descendant = join(directory, 'descendant.ts')
  const parentPidFile = join(directory, 'parent.pid'), descendantPidFile = join(directory, 'descendant.pid')
  await Bun.write(config, 'preload = []\n')
  await Bun.write(descendant, `await Bun.write(process.argv[2]!, String(process.pid)); process.on('SIGTERM', () => {}); await Bun.sleep(60000)`)
  await Bun.write(parent, `const child = Bun.spawn([process.execPath, '--no-env-file', ${JSON.stringify(`--config=${config}`)}, ${JSON.stringify(descendant)}, ${JSON.stringify(descendantPidFile)}], { stdout: 'inherit', stderr: 'inherit' });
while (!await Bun.file(${JSON.stringify(descendantPidFile)}).exists()) await Bun.sleep(5);
await Bun.write(${JSON.stringify(parentPidFile)}, String(process.pid)); child.unref(); process.exit(0)`)
  try {
    await expect(runParityProcess([process.execPath, '--no-env-file', `--config=${config}`, parent], { timeoutMs: 1000, stdoutBytes: 1024, stderrBytes: 1024, label: 'Descendant fixture' })).rejects.toThrow('timed out')
    const parentPid = Number(await readFile(parentPidFile, 'utf8'))
    expect(() => process.kill(parentPid, 0)).toThrow()
    const descendantPid = Number(await readFile(descendantPidFile, 'utf8'))
    let alive = true
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(descendantPid, 0) }
      catch { alive = false; break }
      await Bun.sleep(10)
    }
    expect(alive).toBe(false)
  }
  finally {
    if (await Bun.file(parentPidFile).exists()) { try { process.kill(-Number(await readFile(parentPidFile, 'utf8')), 'SIGKILL') } catch {} }
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)

test('evidence deadlines and output limits fail the selected case, reap its child and still check the next selector', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-parity-evidence-'))
  const testFile = 'tests/unit/evidence.test.ts', pidFile = join(directory, 'child.pid')
  await Bun.write(join(directory, 'bunfig.toml'), 'preload = []\n[test]\nroot = "tests"\n')
  await Bun.write(join(directory, testFile), `import { test } from 'bun:test'
process.on('SIGTERM', () => {})
test('ignores termination', async () => { await Bun.write(${JSON.stringify(`${pidFile}.timeout`)}, String(process.pid)); await Bun.sleep(60000) })
test('overflows output', async () => { await Bun.write(${JSON.stringify(`${pidFile}.overflow`)}, String(process.pid)); await new Promise<void>(resolve => process.stdout.write('x'.repeat(1000001), () => resolve())); await Bun.sleep(60000) })
test('one selected behavior', () => {})
`)
  try {
    const a = details(), c = a.cases.find(c => c.evidence.length)!, evidence = c.evidence[0]!
    c.evidence = ['ignores termination', 'overflows output', 'one selected behavior'].map(testName => ({ ...evidence, testFile, testName }))
    a.cases = [c]
    const result = await runParityEvidence(a, directory, { timeoutMs: 1000 })
    expect(result.map(r => r.passed)).toEqual([false, false, true])
    expect(result[0]!.detail).toContain('timed out')
    expect(result[1]!.detail).toContain('stdout exceeds byte limit')
    for (const suffix of ['timeout', 'overflow']) {
      const pid = Number(await readFile(`${pidFile}.${suffix}`, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    }
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 10000)
