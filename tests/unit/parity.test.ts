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
