import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DownloadError, DownloadHTTPError, MetadataVerificationError, PersistError, Updater } from 'tuf-js'
import { repository } from './repository'

/** Synthetic metadata only. Compiled and run outside the checkout to verify public error identities. */
async function run(directory: string) {
  await mkdir(directory, { mode: 0o700 })
  const results: { kind: string, role?: string, statusCode?: number, causePreserved?: boolean }[] = []
  async function fixture(name: string, options: Parameters<typeof repository>[1] = {}, missing = false) {
    const repo = join(directory, name, 'repo'), cache = join(directory, name, 'cache')
    const data = await repository(repo, options)
    await mkdir(cache, { mode: 0o700 })
    await writeFile(join(cache, 'root.json'), await readFile(data.rootPath), { mode: 0o600 })
    const fetcher = {
      async downloadBytes(url: string, limit: number) {
        const path = new URL(url).pathname
        assert(/^\/metadata\/(?:[0-9]+\.)?(?:root|timestamp|snapshot|targets)\.json$/.test(path))
        if (missing && path === '/metadata/timestamp.json') throw new DownloadHTTPError('Synthetic missing timestamp', 404)
        try {
          const bytes = readFileSync(join(repo, path))
          assert(bytes.length <= limit)
          return bytes
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DownloadHTTPError('Synthetic missing metadata', 404)
          throw error
        }
      },
      async downloadFile(): Promise<never> { throw new Error('This qualifier never downloads image bytes') },
    }
    return { metadataDir: cache, metadataBaseUrl: 'https://offline.invalid/metadata/', fetcher }
  }
  const metadata = await fixture('metadata', { badTargetsSignature: true })
  const prefix: string[] = []
  const rejected = await new Updater({ ...metadata, onVerifiedMetadata(role) { prefix.push(role) } }).refresh().then(() => undefined, error => error)
  assert(rejected instanceof Error && rejected.cause instanceof MetadataVerificationError)
  assert.equal(rejected.cause.role, 'targets')
  assert(rejected.cause.cause instanceof Error)
  assert.deepEqual(prefix, ['timestamp', 'snapshot'])
  results.push({ kind: 'metadata-verification-phase', role: rejected.cause.role, causePreserved: true })

  const persistence = await fixture('persistence')
  const marker = new MetadataVerificationError('timestamp', 'Synthetic observer failure, not an SDK verdict')
  const observed: string[] = []
  const failed = await new Updater({ ...persistence, forceCache: true, onVerifiedMetadata(role) { observed.push(role); throw marker } }).refresh().then(() => undefined, error => error)
  assert(failed instanceof PersistError && failed.cause === marker)
  assert(!(failed instanceof MetadataVerificationError))
  assert.deepEqual(observed, ['timestamp'])
  results.push({ kind: 'persistence-first', role: 'timestamp', causePreserved: true })

  const opaque = await fixture('opaque')
  const opaqueMarker = Symbol('Synthetic opaque observer rejection')
  const opaqueSeen: string[] = []
  const opaqueFailure = await new Updater({ ...opaque, forceCache: true, onVerifiedMetadata(role) { opaqueSeen.push(role); throw opaqueMarker } }).refresh().then(() => undefined, error => error)
  assert(opaqueFailure instanceof PersistError && opaqueFailure.cause === opaqueMarker)
  assert.deepEqual(opaqueSeen, ['timestamp'])
  results.push({ kind: 'opaque-persistence', role: 'timestamp', causePreserved: true })

  const absent = await fixture('missing', {}, true)
  const missing = await new Updater(absent).refresh().then(() => undefined, error => error)
  assert(missing instanceof DownloadHTTPError && missing instanceof DownloadError)
  assert.equal(missing.statusCode, 404)
  results.push({ kind: 'download-phase', statusCode: missing.statusCode })
  return { evidence: 'synthetic-sdk-operational-errors-v1', outcomes: results, physicalDeploymentAllowed: false }
}
if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Use sdk-outcomes-worker NEW_DIRECTORY')
  console.log(JSON.stringify(await run(process.argv[2]!)))
}
