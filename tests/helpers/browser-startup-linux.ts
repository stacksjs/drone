import { createHash } from 'node:crypto'
import { lstat, open, readFile, readlink, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { browserFileErrorCode } from './browser-launch-evidence'

const processLimit = 64, threadLimit = 32, executableLimit = 4, executableByteLimit = 512 * 1024 * 1024
async function text(path: string, signal: AbortSignal) {
  if (signal.aborted) return { value: null, code: 'ABORT_ERR' }
  try {
    const value = await readFile(path, { encoding: 'utf8', signal })
    return value.length <= 32768 ? { value, code: null } : { value: null, code: 'BYTE_LIMIT' }
  }
  catch (error) { return { value: null, code: browserFileErrorCode(error) } }
}
const decimal = (value: string | undefined) => value && /^\d{1,20}$/.test(value) ? value : null
const integer = (value: string | undefined) => { const n = decimal(value); return n !== null && Number.isSafeInteger(Number(n)) ? Number(n) : null }
async function processState(pid: number, signal: AbortSignal) {
  const [raw, status, wait, children] = await Promise.all([text(`/proc/${pid}/stat`, signal), text(`/proc/${pid}/status`, signal), text(`/proc/${pid}/wchan`, signal), text(`/proc/${pid}/task/${pid}/children`, signal)])
  signal.throwIfAborted()
  const end = raw.value?.lastIndexOf(') ') ?? -1
  // tcomm may contain spaces/parentheses and is deliberately discarded.
  const fields = end >= 0 ? raw.value!.slice(end + 2).trim().split(/\s+/) : []
  const valid = fields.length >= 22 && /^[RSDZTtXxKWPI]$/.test(fields[0]!) && decimal(fields[19]) !== null
  const rss = status.value?.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]
  const ids = children.value?.trim().split(/\s+/).map(integer).filter((n): n is number => n !== null && n > 0) ?? []
  return {
    record: { pid, code: valid ? null : raw.code ?? 'FORMAT', state: valid ? fields[0]! : null,
      parentPid: valid ? integer(fields[1]) : null, group: valid ? integer(fields[2]) : null, session: valid ? integer(fields[3]) : null,
      startTicks: valid ? decimal(fields[19]) : null, userTicks: valid ? decimal(fields[11]) : null, systemTicks: valid ? decimal(fields[12]) : null,
      threads: valid ? integer(fields[17]) : null, rssKiB: integer(rss), statusCode: status.code,
      wait: wait.value !== null && /^[A-Za-z0-9_.:]{1,80}$/.test(wait.value.trim()) ? wait.value.trim() : null, waitCode: wait.code, childrenCode: children.code },
    children: ids.slice(0, processLimit), childrenCapped: ids.length > processLimit,
  }
}
async function counters(path: string, allowed: string[], signal: AbortSignal) {
  const result = await text(path, signal), values: Record<string, string> = {}
  signal.throwIfAborted()
  for (const line of result.value?.split('\n') ?? []) {
    const [key, value] = line.trim().split(/\s+/)
    if (key && allowed.includes(key) && decimal(value) !== null) values[key] = value!
  }
  return { values, code: result.code }
}
async function scalar(path: string, signal: AbortSignal) {
  const result = await text(path, signal), value = result.value?.trim()
  signal.throwIfAborted()
  return { value: value === 'max' || decimal(value) !== null ? value! : null, code: result.code ?? (value === 'max' || decimal(value) !== null ? null : 'FORMAT') }
}
async function pressure(resource: string, signal: AbortSignal) {
  const result = await text(`/proc/pressure/${resource}`, signal), values: Record<string, { avg10: number, avg60: number, avg300: number, totalMicroseconds: string }> = {}
  for (const line of result.value?.split('\n') ?? []) {
    const match = /^(some|full) avg10=(\d{1,3}(?:\.\d{1,6})?) avg60=(\d{1,3}(?:\.\d{1,6})?) avg300=(\d{1,3}(?:\.\d{1,6})?) total=(\d{1,20})$/.exec(line)
    if (match) values[match[1]!] = { avg10: Number(match[2]), avg60: Number(match[3]), avg300: Number(match[4]), totalMicroseconds: match[5]! }
  }
  return { values, code: result.code }
}
async function resources(signal: AbortSignal) {
  signal.throwIfAborted()
  const membership = await text('/proc/self/cgroup', signal)
  signal.throwIfAborted()
  const path = membership.value?.split('\n').find(line => line.startsWith('0::'))?.slice(3)
  const base = path?.startsWith('/') && !path.split('/').includes('..') ? join('/sys/fs/cgroup', path) : null
  const [cpuPressure, memoryPressure, ioPressure] = await Promise.all(['cpu', 'memory', 'io'].map(name => pressure(name, signal)))
  signal.throwIfAborted()
  const cgroup = base ? {
    memoryCurrent: await scalar(join(base, 'memory.current'), signal), memoryMax: await scalar(join(base, 'memory.max'), signal),
    memoryEvents: await counters(join(base, 'memory.events'), ['low', 'high', 'max', 'oom', 'oom_kill', 'oom_group_kill', 'sock_throttled'], signal),
    cpu: await counters(join(base, 'cpu.stat'), ['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec', 'nr_bursts', 'burst_usec'], signal),
    pidsCurrent: await scalar(join(base, 'pids.current'), signal), pidsMax: await scalar(join(base, 'pids.max'), signal),
  } : null
  return { scope: 'observer cgroup, potentially shared with other runner processes', pressureScope: 'system pressure, shared with other host workloads', membershipCode: membership.code ?? (base ? null : 'NOT_V2'), cgroup, cpuPressure, memoryPressure, ioPressure }
}

type Executable = { path: string, device: string, inode: string, byteLength: number, observedPids: number[], openedAtMs: number, sha256: string | null, hashedAfterDiscovery: boolean, code: string | null, closeCode: string | null }
/** No argv, environment, comm, stack or memory dump is exported. */
export function createLinuxStartupObservation(pid: number, profile: string, began: number) {
  const tracked = new Map<number, string>(), pinned = new Map<string, { handle: FileHandle, mtimeNs: bigint, ctimeNs: bigint, evidence: Executable }>()
  const identityErrors: Array<{ pid: number, code: string }> = []
  let handlesSealed = false, executableLimitReached = false
  async function executable(id: number, signal: AbortSignal) {
    if (handlesSealed || signal.aborted) return
    let handle: FileHandle | undefined
    try {
      handle = await open(`/proc/${id}/exe`, 'r')
      if (handlesSealed || signal.aborted) return
      const stat = await handle.stat({ bigint: true }), key = `${stat.dev}:${stat.ino}`
      if (handlesSealed || signal.aborted) return
      const prior = pinned.get(key)
      if (prior) { if (!prior.evidence.observedPids.includes(id)) prior.evidence.observedPids.push(id); return }
      if (pinned.size >= executableLimit) { executableLimitReached = true; return }
      const path = await readlink(`/proc/self/fd/${handle.fd}`)
      if (handlesSealed || signal.aborted) return
      if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(executableByteLimit) || path.length > 4096) { if (identityErrors.length < 8) identityErrors.push({ pid: id, code: 'IDENTITY_LIMIT' }); return }
      pinned.set(key, { handle, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, evidence: { path, device: String(stat.dev), inode: String(stat.ino), byteLength: Number(stat.size), observedPids: [id], openedAtMs: performance.now() - began, sha256: null, hashedAfterDiscovery: false, code: null, closeCode: null } })
      handle = undefined
    }
    catch (error) { if (identityErrors.length < 8) identityErrors.push({ pid: id, code: browserFileErrorCode(error) }) }
    finally {
      if (handle) {
        try { await handle.close() }
        catch (closeError) { if (identityErrors.length < 8) identityErrors.push({ pid: id, code: browserFileErrorCode(closeError) }) }
      }
    }
  }
  return {
    async snapshot(signal: AbortSignal) {
      signal.throwIfAborted()
      const root = await processState(pid, signal), descendants: Array<typeof root.record & { reused: boolean }> = []
      const check = (id: number, start: string | null) => {
        if (!start) return false
        const prior = tracked.get(id)
        if (prior && prior !== start) return false
        if (tracked.size < processLimit) tracked.set(id, start)
        return true
      }
      const rootMatches = check(pid, root.record.startTicks)
      if (rootMatches) await executable(pid, signal)
      const queue = [...new Set([...(rootMatches ? root.children : []), ...tracked.keys()].filter(id => id !== pid))]
      const seen = new Set<number>([pid]); let processLimitReached = root.childrenCapped
      while (queue.length && seen.size < processLimit && !signal.aborted) {
        const id = queue.shift()!
        if (seen.has(id)) continue
        seen.add(id)
        const state = await processState(id, signal), matches = check(id, state.record.startTicks)
        descendants.push({ ...state.record, reused: state.record.startTicks !== null && !matches })
        if (matches) { await executable(id, signal); queue.push(...state.children.filter(n => !seen.has(n))); processLimitReached ||= state.childrenCapped }
      }
      processLimitReached ||= queue.length > 0 || tracked.size === processLimit
      signal.throwIfAborted()
      let threadCode: string | null = null
      const allThreads = await readdir(`/proc/${pid}/task`).catch(error => { threadCode = browserFileErrorCode(error); return [] })
      signal.throwIfAborted()
      const threads = await Promise.all(allThreads.filter(id => /^\d+$/.test(id)).slice(0, threadLimit).map(async id => {
        const wait = await text(`/proc/${pid}/task/${id}/wchan`, signal)
        return { tid: Number(id), wait: wait.value !== null && /^[A-Za-z0-9_.:]{1,80}$/.test(wait.value.trim()) ? wait.value.trim() : null, code: wait.code }
      }))
      signal.throwIfAborted()
      const discoveryFile = await lstat(join(profile, 'DevToolsActivePort')).then(value => ({ present: true, regular: value.isFile(), bytes: value.size, code: null })).catch(error => ({ present: false, regular: null, bytes: null, code: browserFileErrorCode(error) }))
      signal.throwIfAborted()
      return { status: 'observed' as const, root: { ...root.record, reused: root.record.startTicks !== null && !rootMatches }, descendants, processLimitReached,
        childScope: 'main-task children and previously observed descendants; incomplete during fork/exit/reparenting', threads, threadCode, threadDetailsCapped: allThreads.length > threadLimit, discoveryFile, resources: await resources(signal) }
    },
    async settleExecutables(shouldHash: boolean) {
      handlesSealed = true
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 2000)
      try {
        for (const { handle, evidence, mtimeNs, ctimeNs } of pinned.values()) {
          try {
            if (!shouldHash) { evidence.code = 'OBSERVATION_CANCELED'; continue }
            if (abort.signal.aborted) { evidence.code = 'HASH_BUDGET'; continue }
            const hash = createHash('sha256'); let bytes = 0
            for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: evidence.byteLength - 1, signal: abort.signal })) { hash.update(chunk); bytes += chunk.length }
            const after = await handle.stat({ bigint: true })
            if (abort.signal.aborted) { evidence.code = 'HASH_BUDGET'; continue }
            if (bytes !== evidence.byteLength || after.size !== BigInt(bytes) || after.mtimeNs !== mtimeNs || after.ctimeNs !== ctimeNs) { evidence.code = 'EXECUTABLE_CHANGED'; continue }
            evidence.sha256 = hash.digest('hex'); evidence.hashedAfterDiscovery = true
          }
          catch (error) { evidence.code = browserFileErrorCode(error) }
          finally { await handle.close().catch(error => { evidence.closeCode = browserFileErrorCode(error) }) }
        }
      }
      finally { clearTimeout(timer) }
    },
    evidence() { return { executables: [...pinned.values()].map(value => structuredClone(value.evidence)), identityErrors: structuredClone(identityErrors), executableLimitReached } },
  }
}
