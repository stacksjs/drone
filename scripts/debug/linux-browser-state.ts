import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

export function observationError(error: unknown) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable'
}
async function text(path: string) {
  try { return { value: (await readFile(path, 'utf8')).slice(0, 32768), error: null } }
  catch (error) { return { value: null, error: observationError(error) } }
}
export async function executableObservation(path: string) {
  const resolved = await realpath(path), hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(resolved)) { hash.update(chunk); bytes += chunk.length }
  return { path, resolved, bytes, sha256: hash.digest('hex') }
}
async function state(pid: number) {
  const raw = await text(`/proc/${pid}/stat`)
  const fields = raw.value?.slice(raw.value.lastIndexOf(') ') + 2).trim().split(/\s+/)
  const status = await text(`/proc/${pid}/status`)
  return { pid, error: raw.error, state: fields?.[0] ?? null, parent: Number(fields?.[1]) || null, group: Number(fields?.[2]) || null, session: Number(fields?.[3]) || null, startTicks: fields?.[19] ?? null, status: status.value?.split('\n').filter(line => /^(?:Name|State|Pid|PPid|Threads|VmRSS|VmSize):/.test(line)) ?? null, wait: await text(`/proc/${pid}/wchan`) }
}
export async function linuxResourceObservation() {
  const membership = await text('/proc/self/cgroup')
  const path = membership.value?.split('\n').find(line => line.startsWith('0::'))?.slice(3)
  const base = path?.startsWith('/') && !path.split('/').includes('..') ? join('/sys/fs/cgroup', path) : null
  const counters: Record<string, Awaited<ReturnType<typeof text>>> = {}
  if (base) {
    for (const name of ['memory.current', 'memory.max', 'memory.events', 'cpu.stat', 'pids.current', 'pids.max']) counters[name] = await text(join(base, name))
  }
  return { scope: 'observing process cgroup, potentially shared with runner processes', membership, counters, memoryPressure: await text('/proc/pressure/memory'), cpuPressure: await text('/proc/pressure/cpu') }
}
/** Startup-only scalar/process observations. Never reads argv, environment or credentials. */
export async function linuxBrowserObservation(pid: number, profile: string) {
  const root = await state(pid)
  const allIds = (await readdir('/proc')).filter(name => /^\d+$/.test(name))
  const ids = allIds.slice(0, 2048), members = []
  for (const value of ids) {
    const candidate = await state(Number(value))
    if (root.group !== null && candidate.group === root.group) members.push(candidate)
  }
  const tasks = await readdir(`/proc/${pid}/task`).catch(() => [])
  const threads = await Promise.all(tasks.slice(0, 64).map(async id => ({ id, name: await text(`/proc/${pid}/task/${id}/comm`), wait: await text(`/proc/${pid}/task/${id}/wchan`) })))
  const discoveryFile = await lstat(join(profile, 'DevToolsActivePort')).then(value => ({ present: true, bytes: value.size, regular: value.isFile(), error: null })).catch(error => ({ present: false, bytes: null, regular: false, error: observationError(error) }))
  return { root, memberCount: members.length, members: members.slice(0, 48), memberDetailsCapped: members.length > 48, processScanCapped: allIds.length > ids.length, threadCount: tasks.length, threads, threadDetailsCapped: tasks.length > 64, discoveryFile, resources: await linuxResourceObservation() }
}
