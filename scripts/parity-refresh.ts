import { open } from 'node:fs/promises'
import inventory from '../docs/roadmap/upstream-inventory.json'
import audit from '../docs/parity-audit.json'
import { entryId } from './parity'
import type { Inventory, ParityAudit } from './parity'

export interface RemoteDirectory { path: string, sha: string, type: string }
export interface UpstreamSnapshot {
  schemaVersion: number
  upstreams: { id: string, revision: string, roots: { path: string, entries: { path: string, treeSha: string }[] }[] }[]
}
export type GitHubReader = (endpoint: string) => Promise<unknown>
const pinned = /^[a-f\d]{40}$/
export interface GitHubProcessOptions { env?: Record<string, string | undefined>, timeoutMs?: number }
export async function readGitHub(endpoint: string, options: GitHubProcessOptions = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 20000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) throw new Error('Invalid GitHub request timeout')
  // gh supplies account authentication without copying credentials into process arguments or reports.
  const child = Bun.spawn(['gh', 'api', endpoint], { stdout: 'pipe', stderr: 'pipe', env: options.env ?? process.env })
  const readers = [child.stdout.getReader(), child.stderr.getReader()]
  const cancellations: Promise<unknown>[] = []
  let failure: Error | undefined
  function stop(error: Error) {
    failure ??= error
    try { child.kill('SIGKILL') }
    catch { /* The process may already have exited. Stream cleanup is still required. */ }
    for (const reader of readers) cancellations.push(reader.cancel().catch(() => {}))
  }
  async function consume(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number, label: string) {
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return Buffer.concat(chunks, bytes).toString('utf8')
        if (value.byteLength > limit - bytes) throw new Error(`GitHub ${label} exceeds inventory byte limit`)
        bytes += value.byteLength
        chunks.push(value)
      }
    }
    catch (error) { stop(error instanceof Error ? error : new Error(String(error))); throw error }
  }
  const timeout = setTimeout(() => stop(new Error('GitHub inventory request timed out')), timeoutMs)
  const stdout = consume(readers[0]!, 2_000_000, 'stdout'), stderr = consume(readers[1]!, 65536, 'stderr')
  try {
    const [code, output, diagnostic] = await Promise.all([child.exited, stdout, stderr])
    if (failure) throw failure
    if (code !== 0) throw new Error(`GitHub inventory request failed: ${diagnostic.slice(-500)}`)
    return JSON.parse(output)
  }
  finally {
    clearTimeout(timeout)
    if (child.exitCode === null) stop(new Error('GitHub inventory request interrupted'))
    await Promise.allSettled([child.exited, stdout, stderr, ...cancellations])
    for (const reader of readers) reader.releaseLock()
  }
}
export async function refreshUpstreamSnapshot(input: Inventory, refs: Record<string, string> = {}, read: GitHubReader = readGitHub): Promise<UpstreamSnapshot> {
  for (const key of Object.keys(refs)) if (!input.upstreams.some(u => u.id === key)) throw new Error(`Unknown upstream: ${key}`)
  const result: UpstreamSnapshot = { schemaVersion: 1, upstreams: [] }
  for (const u of input.upstreams) {
    const ref = refs[u.id] ?? u.revision
    if (!ref || ref.length > 200) throw new Error('Invalid upstream revision')
    const commit = await read(`repos/${u.repository}/commits/${encodeURIComponent(ref)}`) as { sha?: string }
    if (!pinned.test(commit.sha ?? '')) throw new Error(`Unresolved revision: ${u.id}`)
    const revision = commit.sha!
    const roots: UpstreamSnapshot['upstreams'][number]['roots'] = []
    for (const scope of [...u.scope, ...(u.id === 'ardupilot' ? [''] : [])]) {
      const path = scope.replace(/\/$/, '')
      const data = await read(`repos/${u.repository}/contents/${path}?ref=${revision}`)
      if (!Array.isArray(data) || data.length >= 1000) throw new Error(`Incomplete upstream listing: ${u.id}/${path}`)
      const entries = (data as RemoteDirectory[]).filter(e => e.type === 'dir').map(e => {
        if (!pinned.test(e.sha) || !e.path || e.path.includes('..') || (path ? !e.path.startsWith(`${path}/`) || e.path.slice(path.length + 1).includes('/') : e.path.includes('/'))) throw new Error('Invalid upstream directory response')
        return { path: e.path, treeSha: e.sha }
      }).sort((a, b) => a.path.localeCompare(b.path))
      if (new Set(entries.map(e => e.path)).size !== entries.length) throw new Error('Duplicate upstream directory response')
      roots.push({ path, entries })
    }
    result.upstreams.push({ id: u.id, revision, roots })
  }
  return result
}
export function compareUpstreamSnapshot(input: Inventory, details: ParityAudit, snapshot: UpstreamSnapshot) {
  const errors: string[] = [], added: string[] = [], removed: string[] = [], changed: string[] = [], revisions: string[] = []
  if (snapshot.schemaVersion !== 1) errors.push('Unsupported upstream snapshot')
  const seen = new Set<string>()
  for (const remote of snapshot.upstreams) {
    const u = input.upstreams.find(u => u.id === remote.id)
    if (!u || seen.has(remote.id) || !pinned.test(remote.revision)) { errors.push(`Invalid snapshot upstream: ${remote.id}`); continue }
    seen.add(remote.id)
    if (remote.revision !== u.revision) revisions.push(`${u.id}:${u.revision}->${remote.revision}`)
    const scopeRoots = [...u.scope.map(s => s.replace(/\/$/, '')), ...(u.id === 'ardupilot' ? [''] : [])]
    const seenRoots = new Set<string>()
    for (const root of remote.roots) {
      if (!scopeRoots.includes(root.path) || seenRoots.has(root.path)) { errors.push(`Unexpected snapshot root: ${u.id}/${root.path}`); continue }
      seenRoots.add(root.path)
      const expected = root.path === ''
        ? details.rootDirectories.filter(r => r.upstream === u.id).map(r => ({ path: r.path, treeSha: details.vehicleFamilies.find(v => v.upstream === u.id && v.path === r.path)?.treeSha }))
        : u.entries.filter(e => e.path.startsWith(`${root.path}/`))
      const byPath = new Map(expected.map(e => [e.path, e.treeSha])), actual = new Set<string>()
      for (const e of root.entries) {
        const id = entryId(u.id, e.path)
        if (actual.has(e.path) || !pinned.test(e.treeSha)) errors.push(`Invalid snapshot entry: ${id}`)
        actual.add(e.path)
        if (!byPath.has(e.path)) added.push(id)
        else if (byPath.get(e.path) && byPath.get(e.path) !== e.treeSha) changed.push(id)
      }
      for (const e of expected) if (!actual.has(e.path)) removed.push(entryId(u.id, e.path))
    }
    for (const root of scopeRoots) if (!seenRoots.has(root)) errors.push(`Missing snapshot root: ${u.id}/${root}`)
  }
  for (const u of input.upstreams) if (!seen.has(u.id)) errors.push(`Missing snapshot upstream: ${u.id}`)
  return { reviewRequired: !!(errors.length || added.length || removed.length || changed.length || revisions.length), added, removed, changed, revisions, errors }
}

export async function writeUpstreamSnapshot(output: string, snapshot: UpstreamSnapshot) {
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`
  const file = await open(output, 'wx', 0o600).catch(error => {
    if ((error as { code?: string }).code === 'EEXIST') throw new Error('Candidate output already exists')
    throw error
  })
  try { await file.writeFile(payload, 'utf8') }
  finally { await file.close() }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), refs: Record<string, string> = {}
    let output: string | undefined
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--output') output = args[++i]
      else if (args[i] === '--px4') refs.px4 = args[++i] ?? ''
      else if (args[i] === '--ardupilot') refs.ardupilot = args[++i] ?? ''
      else throw new Error(`Unknown argument: ${args[i]}`)
    }
    if (!output) throw new Error('Provide --output for a reviewable candidate snapshot')
    const snapshot = await refreshUpstreamSnapshot(inventory, refs)
    await writeUpstreamSnapshot(output, snapshot)
    const comparison = compareUpstreamSnapshot(inventory, audit as ParityAudit, snapshot)
    console.log(JSON.stringify({ output, ...comparison }, null, 2))
    process.exitCode = comparison.reviewRequired ? 1 : 0
  }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}

export async function verifyParitySources(details: ParityAudit, input: Inventory, read: GitHubReader = readGitHub) {
  const errors: string[] = []
  for (const source of details.sources) {
    const upstream = input.upstreams.find(u => u.id === source.upstream)
    if (!upstream || source.revision !== upstream.revision) { errors.push(`Stale source: ${source.id}`); continue }
    const result = await read(`repos/${upstream.repository}/contents/${source.path}?ref=${source.revision}`) as { sha?: string, encoding?: string, content?: string }
    if (result.encoding !== 'base64' || !result.content || result.content.length > 2_000_000) { errors.push(`Missing bounded source content: ${source.id}`); continue }
    const bytes = Buffer.from(result.content, 'base64'), text = bytes.toString('utf8')
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    const blob = new Bun.CryptoHasher('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
    if (result.sha !== source.blobSha || blob !== source.blobSha || digest !== source.sha256 || text.split('\n').length !== source.lines) errors.push(`Source content changed: ${source.id}`)
    for (const c of details.cases) for (const reference of c.sources.filter(r => r.source === source.id)) {
      if (!text.split('\n')[reference.line - 1]?.includes(reference.symbol)) errors.push(`Source symbol does not support citation: ${c.id}`)
    }
  }
  return errors
}

export async function verifyParityIssueLinks(issues: { url: string }[], read: GitHubReader = readGitHub) {
  const errors: string[] = []
  for (const url of new Set(issues.map(issue => issue.url))) {
    const match = /^https:\/\/github\.com\/stacksjs\/drone\/issues\/(\d+)$/.exec(url)
    if (!match) { errors.push(`Invalid roadmap issue URL: ${url}`); continue }
    const issue = await read(`repos/stacksjs/drone/issues/${match[1]}`) as { number?: number, html_url?: string, state?: string, pull_request?: unknown }
    if (issue.number !== Number(match[1]) || issue.html_url !== url || !['open', 'closed'].includes(issue.state ?? '') || issue.pull_request) errors.push(`Dangling upstream issue link: ${url}`)
  }
  return errors
}
