import { afterEach, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Updater, type UpdaterOptions } from 'tuf-js'
import * as Tuf from 'tuf-js'
import { repository } from '../fixtures/updates/repository'

const roots: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup(options: Parameters<typeof repository>[1] = { rotate: true }, missing?: string) {
  const root = await mkdtemp(join(tmpdir(), 'drone-sdk-test-')); roots.push(root)
  const repo = join(root, 'repo'), cache = join(root, 'cache'), requests: string[] = []
  const fixture = await repository(repo, options)
  await mkdir(cache, { mode: 0o700 })
  await copyFile(fixture.rootPath, join(cache, 'root.json'))
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (!/^\/metadata\/(?:[0-9]+\.)?(?:root|timestamp|snapshot|targets)\.json$/.test(path) || basename(path) === missing) return new Response(null, { status: 404 })
    const file = Bun.file(join(repo, 'metadata', basename(path)))
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 })
  } }); servers.push(server)
  const input = { metadataDir: cache, metadataBaseUrl: `http://127.0.0.1:${server.port}/metadata`, config: { fetchRetries: 0, fetchTimeout: 1000 } } satisfies UpdaterOptions
  return { root, repo, cache, fixture, requests, input }
}

const roles = ['root', 'timestamp', 'snapshot', 'targets'] as const

test('the maintained SDK observer receives exact verified bytes before each cache write', async () => {
  const item = await setup(), seen: string[] = []
  const updater = new Updater({ ...item.input, async onVerifiedMetadata(role, bytes) {
    seen.push(role)
    if (role === 'root') expect(JSON.parse(await readFile(join(item.cache, 'root.json'), 'utf8')).signed.version).toBe(1)
    else expect(await Bun.file(join(item.cache, `${role}.json`)).exists()).toBe(false)
    const file = role === 'root' ? '2.root.json' : role === 'timestamp' ? 'timestamp.json' : `1.${role}.json`
    expect(bytes).toEqual(await readFile(join(item.repo, 'metadata', file)))
  } })
  await updater.refresh()
  expect(seen).toEqual([...roles])
  expect((await readdir(item.cache)).sort()).toEqual(['root.json', 'snapshot.json', 'targets.json', 'timestamp.json'])
})

test('a pending observer prevents the cache write and the next metadata request', async () => {
  const item = await setup()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const seen = new Promise<void>(resolve => { entered = resolve })
  const pending = new Updater({ ...item.input, async onVerifiedMetadata(role) {
    if (role === 'root') { entered(); await gate }
  } }).refresh()
  try {
    await seen
    expect(JSON.parse(await readFile(join(item.cache, 'root.json'), 'utf8')).signed.version).toBe(1)
    expect(item.requests).toEqual(['/metadata/2.root.json'])
  }
  finally { release(); await pending }
})

for (const failedRole of roles) {
  test(`an observer rejection for ${failedRole} aborts before that cache or a later role advances`, async () => {
    const item = await setup(), seen: string[] = [], cause = new Error('protected persistence rejected')
    const updater = new Updater({ ...item.input, async onVerifiedMetadata(role) {
      seen.push(role)
      if (role === failedRole) throw cause
    } })
    const failure = await updater.refresh().then(() => undefined, error => error)
    const persistence = failedRole === 'snapshot' || failedRole === 'targets' ? failure.cause : failure
    expect(persistence).toBeInstanceOf(Tuf.PersistError)
    expect(persistence.message).toBe(`Failed to persist metadata ${failedRole}`)
    expect(persistence.cause).toBe(cause)
    expect(seen).toEqual(roles.slice(0, roles.indexOf(failedRole) + 1))
    if (failedRole === 'root') expect(JSON.parse(await readFile(join(item.cache, 'root.json'), 'utf8')).signed.version).toBe(1)
    else expect(await Bun.file(join(item.cache, `${failedRole}.json`)).exists()).toBe(false)
  })
}

test('a genuine SDK HTTP404 thrown by the observer cannot be mistaken for the end of root rotation', async () => {
  const source = await setup({ rotate: false }, 'timestamp.json')
  const downloadFailure = await new Updater(source.input).refresh().then(() => { throw new Error('Missing metadata unexpectedly succeeded') }, error => error)
  expect(downloadFailure.statusCode).toBe(404)
  const item = await setup(), seen: string[] = []
  await expect(new Updater({ ...item.input, onVerifiedMetadata(role) { seen.push(role); throw downloadFailure } }).refresh()).rejects.toThrow('Failed to persist metadata root')
  expect(seen).toEqual(['root'])
  expect(JSON.parse(await readFile(join(item.cache, 'root.json'), 'utf8')).signed.version).toBe(1)
})

test('the observer owns a byte copy and cannot mutate SDK verification or cache bytes', async () => {
  const item = await setup(), observed: Record<string, Buffer> = {}
  await new Updater({ ...item.input, onVerifiedMetadata(role, bytes) { observed[role] = Buffer.from(bytes); bytes.fill(0) } }).refresh()
  for (const role of roles) expect((await readFile(join(item.cache, `${role}.json`))).equals(observed[role]!)).toBe(true)
})

test('an unauthorized root never reaches the observer and leaves the initial cache intact', async () => {
  const item = await setup({ rotate: true, badRotation: true }), seen: string[] = []
  await expect(new Updater({ ...item.input, onVerifiedMetadata(role) { seen.push(role) } }).refresh()).rejects.toThrow()
  expect(seen).toEqual([])
  expect(JSON.parse(await readFile(join(item.cache, 'root.json'), 'utf8')).signed.version).toBe(1)
})

test('a later invalid target signature preserves only the earlier verified metadata observations', async () => {
  const item = await setup({ rotate: true, badTargetsSignature: true }), seen: string[] = []
  await expect(new Updater({ ...item.input, onVerifiedMetadata(role) { seen.push(role) } }).refresh()).rejects.toThrow()
  expect(seen).toEqual(['root', 'timestamp', 'snapshot'])
  expect(await Bun.file(join(item.cache, 'targets.json')).exists()).toBe(false)
})

test('snapshot-bound tampering is rejected before it reaches the observer', async () => {
  const item = await setup(), seen: string[] = []
  await writeFile(join(item.repo, 'metadata/1.targets.json'), '{}')
  await expect(new Updater({ ...item.input, onVerifiedMetadata(role) { seen.push(role) } }).refresh()).rejects.toThrow()
  expect(seen).toEqual(['root', 'timestamp', 'snapshot'])
})

test('the supplied fixed start time is owned before callers can mutate it', async () => {
  const item = await setup(), time = new Date('2030-01-01T00:00:00Z')
  const updater = new Updater({ ...item.input, referenceTime: time })
  time.setUTCFullYear(2040)
  await updater.refresh()
  expect(JSON.parse(await readFile(join(item.cache, 'root.json'), 'utf8')).signed.version).toBe(2)
})

test('fixed-time recovery replay is distinct from current-time authorization', async () => {
  const past = await setup({ expires: '2025-01-01T00:00:00Z' })
  await new Updater({ ...past.input, referenceTime: new Date('2024-01-01T00:00:00Z') }).refresh()
  const current = await setup({ expires: '2025-01-01T00:00:00Z' })
  const failure = await new Updater(current.input).refresh().then(() => undefined, error => error)
  expect(failure).toBeInstanceOf(Tuf.MetadataVerificationError)
  expect(failure.role).toBe('timestamp')
  expect(failure.cause).toBeInstanceOf(Error)
  expect(failure.cause.message).toContain('expired')
})

test('invalid fixed time is rejected before loading even a missing bootstrap root', () => {
  expect(() => new Updater({ metadataDir: '/missing-drone-sdk-bootstrap', metadataBaseUrl: 'http://127.0.0.1:1', referenceTime: new Date(Number.NaN) })).toThrow('Invalid fixed update reference time')
})


test('a fully cached trusted refresh does not emit observations for cache bytes', async () => {
  const item = await setup()
  await new Updater(item.input).refresh()
  const seen: string[] = []
  await new Updater({ ...item.input, onVerifiedMetadata(role) { seen.push(role) } }).refresh()
  expect(seen).toEqual([])
})

test('an authenticated intermediate root is observed before final-root expiry rejects the refresh', async () => {
  const item = await setup({ rotate: true, metadataFields: { rotatedRoot: { expires: '2020-01-01T00:00:00Z' } } }), seen: string[] = []
  const failure = await new Updater({ ...item.input, onVerifiedMetadata(role) { seen.push(role) } }).refresh().then(() => undefined, error => error)
  expect(failure).toBeInstanceOf(Tuf.MetadataVerificationError)
  expect(failure.role).toBe('timestamp')
  expect(failure.cause).toBeInstanceOf(Error)
  expect(failure.cause.message).toContain('expired')
  expect(seen).toEqual(['root'])
  expect(JSON.parse(await readFile(join(item.cache, 'root.json'), 'utf8')).signed.version).toBe(2)
})


test('forceCache cannot swallow a rejected remote timestamp observer when its local cache is missing', async () => {
  const item = await setup({ rotate: false }), seen: string[] = []
  await expect(new Updater({ ...item.input, forceCache: true, onVerifiedMetadata(role) {
    seen.push(role)
    if (role === 'timestamp') throw new Error('protected timestamp persistence rejected')
  } }).refresh()).rejects.toThrow('Failed to persist metadata timestamp')
  expect(seen).toEqual(['timestamp'])
  expect(item.requests).toEqual(['/metadata/timestamp.json'])
  expect((await readdir(item.cache)).sort()).toEqual(['root.json'])
})


test('a signed metadata rejection retains its original typed cause through the SDK wrapper', async () => {
  const item = await setup({ badTargetsSignature: true })
  const failure = await new Updater(item.input).refresh().then(() => undefined, error => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure.cause).toBeInstanceOf(Error)
})


test('recovery can identify a remote metadata rejection through a public typed cause', async () => {
  const item = await setup({ badTargetsSignature: true })
  const failure = await new Updater(item.input).refresh().then(() => undefined, error => error)
  expect(Tuf.MetadataVerificationError).toBeFunction()
  expect(failure.cause).toBeInstanceOf(Tuf.MetadataVerificationError)
  expect(failure.cause.role).toBe('targets')
})


for (const role of roles) {
  test(`remote ${role} verification failure has a typed role and original cause`, async () => {
    const options: Parameters<typeof repository>[1] = role === 'root' ? { rotate: true, badRotation: true } : { metadataFields: { [role]: { expires: '2020-01-01T00:00:00Z' } } }
    const item = await setup(options)
    const failure = await new Updater(item.input).refresh().then(() => undefined, error => error)
    const verification = failure instanceof Tuf.MetadataVerificationError ? failure : failure.cause
    expect(verification).toBeInstanceOf(Tuf.MetadataVerificationError)
    expect(verification.role).toBe(role)
    expect(verification.cause).toBeInstanceOf(Error)
  })
}

test('observer failure stays a persistence failure and preserves its exact cause', async () => {
  const item = await setup(), cause = new Error('protected storage failure')
  const failure = await new Updater({ ...item.input, onVerifiedMetadata() { throw cause } }).refresh().then(() => undefined, error => error)
  expect(failure).toBeInstanceOf(Tuf.PersistError)
  expect(failure).not.toBeInstanceOf(Tuf.MetadataVerificationError)
  expect(failure.cause).toBe(cause)
  expect(item.requests).toEqual(['/metadata/2.root.json'])
})

test('an observer-supplied verification error is still classified as failed persistence first', async () => {
  const item = await setup({ rotate: false }), cause = new Tuf.MetadataVerificationError('timestamp', 'caller error, not an SDK verification verdict')
  const failure = await new Updater({ ...item.input, forceCache: true, onVerifiedMetadata() { throw cause } }).refresh().then(() => undefined, error => error)
  expect(failure).toBeInstanceOf(Tuf.PersistError)
  expect(failure.cause).toBe(cause)
  expect(item.requests).toEqual(['/metadata/timestamp.json'])
})

test('the public HTTP failure class matches actual missing-metadata failures', async () => {
  const item = await setup({ rotate: false }, 'timestamp.json')
  const failure = await new Updater(item.input).refresh().then(() => undefined, error => error)
  expect(failure).toBeInstanceOf(Tuf.DownloadHTTPError)
  expect(failure).toBeInstanceOf(Tuf.DownloadError)
  expect(failure.statusCode).toBe(404)
  expect(failure).not.toBeInstanceOf(Tuf.MetadataVerificationError)
})

test('a Symbol observer rejection remains a persistence failure under forceCache', async () => {
  const item = await setup({ rotate: false }), seen: string[] = [], cause = Symbol('opaque storage failure')
  const failure = await new Updater({ ...item.input, forceCache: true, onVerifiedMetadata(role) {
    seen.push(role)
    if (role === 'timestamp') throw cause
  } }).refresh().then(() => undefined, error => error)
  expect(failure).toBeInstanceOf(Tuf.PersistError)
  expect(failure.cause).toBe(cause)
  expect(seen).toEqual(['timestamp'])
  expect(item.requests).toEqual(['/metadata/timestamp.json'])
  expect((await readdir(item.cache)).sort()).toEqual(['root.json'])
})

test('observer failures are never coerced while wrapping any metadata role', async () => {
  for (const failedRole of roles) {
    const item = await setup(), seen: string[] = []
    let coercions = 0
    const cause = { toString() { coercions++; throw new Error('Cause coercion must not run') } }
    const failure = await new Updater({ ...item.input, onVerifiedMetadata(role) {
      seen.push(role)
      if (role === failedRole) throw cause
    } }).refresh().then(() => undefined, error => error)
    const persistence = failedRole === 'snapshot' || failedRole === 'targets' ? failure.cause : failure
    expect(persistence).toBeInstanceOf(Tuf.PersistError)
    expect(persistence.cause).toBe(cause)
    expect(coercions).toBe(0)
    expect(seen).toEqual(roles.slice(0, roles.indexOf(failedRole) + 1))
    if (failedRole === 'root') expect(JSON.parse(await readFile(join(item.cache, 'root.json'), 'utf8')).signed.version).toBe(1)
    else expect(await Bun.file(join(item.cache, `${failedRole}.json`)).exists()).toBe(false)
  }
})
