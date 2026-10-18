import { resolve, relative, isAbsolute } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { runParityProcess } from './parity-process'

export const parityDimensions = ['parameters', 'modes', 'protocols', 'hardware', 'failures'] as const
export type ParityDimension = typeof parityDimensions[number]
export interface UpstreamEntry { path: string, treeSha: string, roadmapKey: string, source: string, issue: string }
export interface Upstream { id: string, repository: string, revision: string, scope: string[], entries: UpstreamEntry[] }
export interface Inventory { schemaVersion: number, upstreams: Upstream[] }
export interface WorkItem { key: string, url: string }
export interface Evidence {
  kind: 'unit' | 'simulation' | 'scripted-protocol' | 'host-bench' | 'sitl' | 'hil' | 'vehicle'
  testFile: string
  testName: string
  firmware: { status: 'not-run' | 'tested', revision: string | null, version: string | null }
  artifact: string | null
}
export interface ParityCase {
  id: string
  entry: string
  dimension: ParityDimension
  behavior: string
  support: 'native-subset' | 'adapter-subset' | 'unsupported' | 'unimplemented'
  sources: { source: string, line: number, symbol: string }[]
  evidence: Evidence[]
  limitations: string[]
}
export interface Assignment {
  entry: string
  issueKey: string
  unclassified: ParityDimension[]
  reviewed: ParityDimension[]
  remaining: string
}
export interface Source {
  id: string
  upstream: string
  path: string
  revision: string
  blobSha: string
  sha256: string
  lines: number
  url: string
  license: string
  licenseSource: string
}
export interface ParityAudit {
  schemaVersion: number
  reviewedAt: string
  assignments: Assignment[]
  vehicleFamilies: (UpstreamEntry & { upstream: string })[]
  rootDirectories: { upstream: string, path: string, classification: 'vehicle-family' | 'infrastructure', reason: string }[]
  sources: Source[]
  cases: ParityCase[]
}
const sha = /^[a-f\d]{40}$/
const hash = /^[a-f\d]{64}$/
export const entryId = (upstream: string, path: string) => `${upstream}:${path}`
export function localParityPath(root: string, path: string) {
  const absolute = resolve(root, path), rel = relative(resolve(root), absolute)
  if (!path || isAbsolute(path) || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Unsafe parity path: ${path}`)
  return absolute
}
export function checkParityAudit(inventory: Inventory, issues: WorkItem[], audit: ParityAudit, root = process.cwd()) {
  const errors: string[] = []
  const entries = new Map<string, UpstreamEntry>()
  const upstreams = new Map(inventory.upstreams.map(u => [u.id, u]))
  const work = new Map(issues.map(i => [i.key, i.url]))
  if (audit.schemaVersion !== 1 || inventory.schemaVersion !== 1) errors.push('Unsupported parity schema')
  if (inventory.upstreams.reduce((n, u) => n + u.entries.length, 0) !== 274) errors.push('Pinned directory scope changed; review the baseline before updating the coverage gate')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(audit.reviewedAt)) errors.push('Missing audit review date')
  for (const u of inventory.upstreams) {
    if (!sha.test(u.revision)) errors.push(`Unpinned revision: ${u.id}`)
    for (const e of u.entries) {
      const id = entryId(u.id, e.path)
      if (entries.has(id) || !sha.test(e.treeSha) || !u.scope.some(s => e.path.startsWith(s) && !e.path.slice(s.length).includes('/'))
        || e.source !== `https://github.com/${u.repository}/tree/${u.revision}/${e.path}`) errors.push(`Invalid inventory entry: ${id}`)
      entries.set(id, e)
    }
  }
  const inventoryEntries = entries.size
  for (const e of audit.vehicleFamilies) {
    const u = upstreams.get(e.upstream), id = entryId(e.upstream, e.path)
    if (!u || entries.has(id) || !sha.test(e.treeSha) || e.source !== `https://github.com/${u.repository}/tree/${u.revision}/${e.path}`) errors.push(`Invalid vehicle family: ${id}`)
    entries.set(id, e)
  }
  const roots = new Set<string>()
  for (const r of audit.rootDirectories) {
    const id = entryId(r.upstream, r.path)
    if (roots.has(id) || !upstreams.has(r.upstream) || !r.reason.trim()
      || !['vehicle-family', 'infrastructure'].includes(r.classification)
      || (r.classification === 'vehicle-family' && !audit.vehicleFamilies.some(e => entryId(e.upstream, e.path) === id))) errors.push(`Invalid root classification: ${id}`)
    roots.add(id)
  }
  for (const v of audit.vehicleFamilies) if (!roots.has(entryId(v.upstream, v.path))) errors.push(`Unclassified vehicle root: ${v.path}`)
  const assignments = new Map<string, Assignment>()
  let unclassifiedDimensions = 0
  for (const a of audit.assignments) {
    const e = entries.get(a.entry)
    if (!e || assignments.has(a.entry) || a.issueKey !== e.roadmapKey || work.get(a.issueKey) !== e.issue) errors.push(`Unassigned or dangling work item: ${a.entry}`)
    const dimensions = [...a.unclassified, ...a.reviewed]
    if (new Set(dimensions).size !== parityDimensions.length || dimensions.length !== parityDimensions.length
      || !parityDimensions.every(d => dimensions.includes(d)) || !a.remaining.trim()) errors.push(`Incomplete detail classification: ${a.entry}`)
    unclassifiedDimensions += a.unclassified.length
    assignments.set(a.entry, a)
  }
  for (const id of entries.keys()) if (!assignments.has(id)) errors.push(`Unassigned upstream entry: ${id}`)
  const sources = new Map<string, Source>()
  for (const s of audit.sources) {
    const u = upstreams.get(s.upstream)
    if (!u || sources.has(s.id) || s.revision !== u.revision || !sha.test(s.blobSha) || !hash.test(s.sha256)
      || !Number.isSafeInteger(s.lines) || s.lines < 1 || !['BSD-3-Clause', 'GPL-3.0-or-later'].includes(s.license)
      || !/^[\w./-]+$/.test(s.path) || s.path.split('/').includes('..')
      || s.url !== `https://github.com/${u.repository}/blob/${u.revision}/${s.path}`
      || !s.licenseSource.startsWith(`https://github.com/${u.repository}/blob/${u.revision}/`)) errors.push(`Invalid source provenance: ${s.id}`)
    sources.set(s.id, s)
  }
  for (const s of audit.sources) if (!audit.sources.some(license => license.url === s.licenseSource && license.upstream === s.upstream)) errors.push(`Missing pinned license source: ${s.id}`)
  const cases = new Set<string>()
  let claimedCases = 0
  for (const c of audit.cases) {
    const a = assignments.get(c.entry)
    if (cases.has(c.id) || !c.id || !a || !a.reviewed.includes(c.dimension) || !c.behavior.trim()
      || !['native-subset', 'adapter-subset', 'unsupported', 'unimplemented'].includes(c.support)) errors.push(`Invalid behavior case: ${c.id}`)
    cases.add(c.id)
    if (!c.limitations.length || c.limitations.some(l => !l.trim()) || !c.sources.length) errors.push(`Missing limits or sources: ${c.id}`)
    for (const r of c.sources) {
      const s = sources.get(r.source)
      if (!s || !c.entry.startsWith(`${s.upstream}:`) || !s.path.startsWith(`${c.entry.split(':')[1]}/`) || !r.symbol.trim()
        || !Number.isSafeInteger(r.line) || r.line < 1 || r.line > s.lines) errors.push(`Missing pinned case source: ${c.id}`)
    }
    const claimed = c.support === 'native-subset' || c.support === 'adapter-subset'
    if (claimed) { claimedCases++; if (!c.evidence.length) errors.push(`Claim lacks executable evidence: ${c.id}`) }
    for (const e of c.evidence) {
      try {
        const file = localParityPath(root, e.testFile)
        if (!/^tests\/.*\.test\.ts$/.test(e.testFile) || !existsSync(file) || !e.testName.trim()
          || !readFileSync(file, 'utf8').includes(`test('${e.testName}'`)) errors.push(`Dangling executable evidence: ${c.id}`)
        if (!['unit', 'simulation', 'scripted-protocol', 'host-bench', 'sitl', 'hil', 'vehicle'].includes(e.kind)) errors.push(`Invalid evidence kind: ${c.id}`)
        const physical = ['sitl', 'hil', 'vehicle'].includes(e.kind)
        if (physical && (e.firmware.status !== 'tested' || !e.firmware.version || !sha.test(e.firmware.revision ?? '') || !e.artifact)) errors.push(`Missing firmware/environment evidence: ${c.id}`)
        if (!physical && (e.firmware.status !== 'not-run' || e.firmware.revision !== null || e.firmware.version !== null)) errors.push(`Synthetic evidence claims firmware validation: ${c.id}`)
        if (e.artifact && !existsSync(localParityPath(root, e.artifact))) errors.push(`Missing evidence artifact: ${c.id}`)
      }
      catch { errors.push(`Invalid evidence path: ${c.id}`) }
    }
  }
  for (const a of audit.assignments) for (const d of a.reviewed) {
    if (!audit.cases.some(c => c.entry === a.entry && c.dimension === d)) errors.push(`Reviewed dimension lacks a case: ${a.entry}/${d}`)
  }
  return {
    validAudit: errors.length === 0,
    // Schema v1 records subsets and gaps. It cannot certify complete upstream equivalence.
    parityComplete: false,
    reviewComplete: errors.length === 0 && unclassifiedDimensions === 0 && audit.assignments.every(a => a.remaining === 'none'),
    inventoryEntries, vehicleFamilies: audit.vehicleFamilies.length, behaviorCases: audit.cases.length,
    claimedCases, unclassifiedDimensions,
    unsupportedCases: audit.cases.filter(c => c.support === 'unsupported' || c.support === 'unimplemented').length,
    errors,
  }
}
export interface ParityEvidenceOptions { timeoutMs?: number, env?: Record<string, string | undefined> }
export async function runParityEvidence(audit: ParityAudit, root = process.cwd(), options: ParityEvidenceOptions = {}) {
  const results: { testFile: string, testName: string, kind: Evidence['kind'], testSha256: string, passed: boolean, detail: string }[] = []
  const seen = new Set<string>()
  for (const c of audit.cases) for (const e of c.evidence) {
    const key = `${e.testFile}:${e.testName}`
    if (seen.has(key)) continue
    seen.add(key)
    const escaped = e.testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let passed = false, detail: string
    try {
      const result = await runParityProcess([process.execPath, 'test', `./${e.testFile}`, '--test-name-pattern', `${escaped}$`], { cwd: root, env: options.env, timeoutMs: options.timeoutMs ?? 60000, stdoutBytes: 1_000_000, stderrBytes: 1_000_000, label: 'Parity evidence' })
      const output = `${result.stdout}\n${result.stderr}`
      passed = result.exitCode === 0 && /\b1 pass\b/.test(output) && /\b0 fail\b/.test(output)
      detail = passed ? 'One selected behavior passed; evidence environment unchanged' : output.slice(-4000)
    }
    catch (error) { detail = (error instanceof Error ? error.message : String(error)).slice(-4000) }
    results.push({ testFile: e.testFile, testName: e.testName, kind: e.kind, testSha256: new Bun.CryptoHasher('sha256').update(readFileSync(localParityPath(root, e.testFile))).digest('hex'), passed, detail })
  }
  return results
}
