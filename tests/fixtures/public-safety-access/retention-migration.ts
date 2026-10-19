import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { retainedPreview } from '../../helpers/public-safety-retained'

const root = realpathSync(process.cwd()), source = resolve(import.meta.dir, '../../..')
assert(basename(root).startsWith('drone-incident-access-custody-upgrade-'))
assert.equal(join(realpathSync(dirname(process.env.DB_DATABASE_PATH!)), basename(process.env.DB_DATABASE_PATH!)), join(root, 'access.sqlite'))
const oldCommit = '4e42cd275f247fbbf487340a1231305cb18fea7d'
const archive = join(root, 'old-source'), evidence = join(root, 'old-source-evidence.json')
const snapshotPath = 'storage/framework/database/model-snapshot.sqlite.json'
const tables = ['public_safety_incidents', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_sources', 'public_safety_observations', 'public_safety_reviews', 'public_safety_managed_artifacts', 'public_safety_managed_artifact_files', 'public_safety_managed_artifact_events']
const mode = process.argv[2]
if (!mode) {
  // Match historical services/models/SQL. Current services require C columns absent from this old DB.
  assert.equal(Bun.spawnSync(['git', 'cat-file', '-e', `${oldCommit}^{commit}`], { cwd: source, stdout: 'pipe', stderr: 'pipe' }).exitCode, 0, 'Pinned B Git object is required; CI must fetch full history')
  await mkdir(archive)
  const exported = Bun.spawnSync(['git', 'archive', oldCommit, 'app/Models', 'database/migrations', snapshotPath, 'resources/functions', 'tests/fixtures/public-safety-access'], { cwd: source, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(exported.exitCode, 0, exported.stderr.toString())
  const unpacked = Bun.spawnSync(['tar', '-xf', '-', '-C', archive], { stdin: exported.stdout, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(unpacked.exitCode, 0, unpacked.stderr.toString())
  await mkdir(join(archive, 'storage/framework'), { recursive: true })
  await symlink(join(source, 'storage/framework/defaults'), join(archive, 'storage/framework/defaults'))
  await symlink(join(source, 'node_modules'), join(archive, 'node_modules'))
  for (const phase of ['seed', 'upgrade']) {
    const child = Bun.spawn([process.execPath, `--config=${join(root, 'bunfig.toml')}`, '--no-env-file', import.meta.path, phase], { cwd: root, env: { ...process.env, CUSTODY_UPGRADE_PHASE: phase }, stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => { if (child.exitCode === null) { try { process.kill(child.pid, 'SIGKILL') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error } } }, 60000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, `${phase}\n${stdout}\n${stderr}`)
      console.log(stdout)
    }
    finally {
      clearTimeout(timeout)
      if (child.exitCode === null) {
        try { process.kill(child.pid, 'SIGKILL') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
        await child.exited
      }
    }
  }
  console.log('PASS native custody upgrade preserves old content without automatic enrollment')
}
else if (mode === 'seed' || mode === 'upgrade') {
  const codeRoot = mode === 'seed' ? archive : source
  const { setupIncidentDatabase } = await import(join(codeRoot, 'tests/fixtures/public-safety-access/setup.ts')) as typeof import('./setup')
  const { database, User } = await setupIncidentDatabase({ reuseDatabase: mode === 'upgrade', async prepareMigrations(directory) {
    if (mode !== 'seed') return
    await mkdir(join(directory, 'pending-custody-migrations'))
    const custodyFiles = (await readdir(join(directory, 'database/migrations'))).filter(name => /^178948669857[01]-/.test(name))
    assert.equal(custodyFiles.length, 2)
    for (const name of custodyFiles) await rename(join(directory, 'database/migrations', name), join(directory, 'pending-custody-migrations', name))
  } })
  const retention = await import(join(codeRoot, 'resources/functions/drone/public-safety/retention/service.ts')) as typeof import('../../../resources/functions/drone/public-safety/retention/service')
  const access = await import(join(codeRoot, 'resources/functions/drone/public-safety/access/service.ts')) as typeof import('../../../resources/functions/drone/public-safety/access/service')
  const records = await import(join(codeRoot, 'resources/functions/drone/public-safety/access/records.ts')) as typeof import('../../../resources/functions/drone/public-safety/access/records')
  const { publicSafetyRetentionGate } = await import(join(codeRoot, 'resources/functions/drone/public-safety/retention/policy.ts')) as typeof import('../../../resources/functions/drone/public-safety/retention/policy')
  const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import(join(codeRoot, 'resources/functions/drone/public-safety/access/policy.ts')) as typeof import('../../../resources/functions/drone/public-safety/access/policy')
  const { incidentAbilities } = await import(join(codeRoot, 'resources/functions/drone/public-safety/access/types.ts')) as typeof import('../../../resources/functions/drone/public-safety/access/types')
  const { Gate } = await import('@stacksjs/auth/gate')
  const { Rbac } = await import('@stacksjs/auth/rbac')
  const { createToken } = await import('@stacksjs/auth/tokens')
  const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
  const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
  setAmbientRequestContext(true)
  Gate.define('public-safety:create', publicSafetyCreateGate)
  for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
  for (const ability of ['read', 'manage', 'revoke'] as const) Gate.define(`public-safety:retention-${ability}`, (user, key) => publicSafetyRetentionGate(user, key, ability))
  const as = <T>(token: string, work: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), work)
  const projection = async (digest: string, observation: number) => ({ incident: await access.readPublicSafetyIncident('custody-upgrade'), source: await records.readPublicSafetySource('custody-upgrade', digest), observation: await records.readPublicSafetyObservation('custody-upgrade', observation), reviews: await records.listPublicSafetyReviews('custody-upgrade', observation), audit: await access.readPublicSafetyAudit('custody-upgrade') })
  try {
    if (mode === 'seed') {
      const user = await User.create({ name: 'Custody Upgrade', email: 'custody-upgrade@example.invalid', password: 'temporary-fixture-password' })
      for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(user.id, permission, 'web') }
      const token = (await createToken(user.id, 'custody upgrade', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
      await as(token, async () => {
        const { examplePublicSafetyConfig } = await import(join(archive, 'resources/functions/drone/public-safety/fixtures.ts')) as typeof import('../../../resources/functions/drone/public-safety/fixtures')
        const { simulatePublicSafety } = await import(join(archive, 'resources/functions/drone/public-safety/runtime.ts')) as typeof import('../../../resources/functions/drone/public-safety/runtime')
        const config = examplePublicSafetyConfig(); config.id = 'custody-upgrade'; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
        await access.createPublicSafetyIncident({ config })
        const registered = await records.registerPublicSafetySource(config.id, { expectedVersion: 1, recording: simulatePublicSafety({ config, seconds: 10 }) })
        const point = await records.appendPublicSafetyObservation(config.id, { expectedVersion: 2, sourceDigest: registered.source.digest, captureId: 'photo-0001', modality: 'visible', pixel: { x: 0, y: 71 }, note: 'Upgrade private observation retained', uncertaintyNote: 'Upgrade uncertainty retained' })
        const review = await records.appendPublicSafetyReview(config.id, point.observation.id, { expectedVersion: 3, sourceDigest: registered.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Upgrade private review retained' })
        assert.deepEqual(await database.db.unsafe("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'public_safety_retention_%'"), [], 'Historical database genuinely predates native custody tables')
        const rows = Object.fromEntries(await Promise.all(tables.map(async table => [table, await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute()])))
        for (const table of tables.slice(0, 6)) assert(rows[table].length > 0, `${table} requires actual historical source-bound records`)
        for (const table of tables.slice(6)) assert.deepEqual(rows[table], [])
        await writeFile(evidence, JSON.stringify({ rows, ledger: await database.db.unsafe('SELECT * FROM migrations ORDER BY id'), token, digest: registered.source.digest, observation: point.observation.id, review: review.review, projection: await projection(registered.source.digest, point.observation.id) }))
        assert.equal(readFileSync(join(root, snapshotPath), 'utf8'), readFileSync(join(archive, snapshotPath), 'utf8'))
        assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
        assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
      })
      console.log('PASS archived B native APIs seed genuine pre-custody source observation review and audit evidence')
    }
    else {
      const before = JSON.parse(readFileSync(evidence, 'utf8')) as { rows: Record<string, unknown[]>, ledger: { migration: string }[], token: string, digest: string, observation: number, review: unknown, projection: Awaited<ReturnType<typeof projection>> }
      const oldCorpus = new Set(await readdir(join(archive, 'database/migrations')))
      // The native runner selects active models; unrelated default SQL in the corpus is not pending.
      // Include the two genuinely deferred old files plus actual new committed corpus additions.
      const pending = (await readdir(join(root, 'database/migrations'))).filter(name => name.endsWith('.sql') && (!oldCorpus.has(name) || /^178948669857[01]-/.test(name)) && !before.ledger.some(entry => entry.migration === name)).sort()
      assert(pending.some(name => /^1789486698570-/.test(name)))
      assert(pending.some(name => /^1789486698571-/.test(name)))
      assert(pending.some(name => /^1789486698578-/.test(name)))
      const migrated = await database.runDatabaseMigration(); if (migrated.isErr) throw migrated.error
      assert.deepEqual(Object.fromEntries(await Promise.all(tables.map(async table => [table, await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute()]))), before.rows, 'Every historical row ID and value survives actual custody+C migration')
      const ledger = await database.db.unsafe('SELECT * FROM migrations ORDER BY id') as { migration: string }[]
      assert.deepEqual(ledger.slice(0, before.ledger.length), before.ledger)
      assert.deepEqual(ledger.slice(before.ledger.length).map(entry => entry.migration).sort(), pending, 'Actual pending SQL names match the real native ledger additions')
      console.log(`PASS actual pending migration ledger applied ${pending.length} immutable custody+C SQL files`)
      assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
      assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
      assert.deepEqual(await database.db.unsafe('PRAGMA foreign_keys'), [{ foreign_keys: 1 }])
      await as(before.token, async () => {
        assert.deepEqual(await projection(before.digest, before.observation), before.projection)
        for (const table of ['public_safety_retention_scopes', 'public_safety_retention_events', 'public_safety_purges', 'public_safety_purge_items', 'public_safety_purge_events']) assert.deepEqual(await database.db.primary.selectFrom(table).selectAll().execute(), [], 'Upgrade never enrolls custody or accepts purge')
        const preview = retainedPreview(await retention.previewPublicSafetyRetention('custody-upgrade'))
        assert.deepEqual(preview.counts, { sources: 1, observations: 1, reviews: 1 })
        const enrollment = await retention.enrollPublicSafetyRetention('custody-upgrade', { expectedVersion: 4, policyVersion: 'local-managed-v1', inventoryDigest: preview.inventoryDigest, requestId: randomUUID() })
        assert.equal(enrollment.scope.contentDeletionPerformed, false)
        assert.equal((await records.readPublicSafetySource('custody-upgrade', before.digest)).source.digest, before.digest)
        assert.deepEqual(await records.readPublicSafetyObservation('custody-upgrade', before.observation), before.projection.observation)
        assert.deepEqual((await records.listPublicSafetyReviews('custody-upgrade', before.observation)).entries, [before.review])
        const event = (await database.db.primary.selectFrom('public_safety_retention_events').selectAll().execute())[0]!
        const { id, ...duplicate } = event
        assert(id)
        await assert.rejects(() => database.db.primary.insertInto('public_safety_retention_events').values(duplicate).execute(), /UNIQUE constraint failed/)
        await assert.rejects(() => database.db.primary.insertInto('public_safety_retention_events').values({ ...duplicate, scope_id: 2147483647 }).execute(), /FOREIGN KEY constraint failed/)
      })
      const snapshot = readFileSync(join(root, snapshotPath), 'utf8'), files = (await readdir(join(root, 'database/migrations'))).sort()
      assert.equal(snapshot, readFileSync(join(source, snapshotPath), 'utf8'))
      for (let pass = 0; pass < 2; pass++) {
        const generated = await database.generateMigrations(); if (generated.isErr) throw generated.error
        assert.equal((await database.pendingMigrationOperations()).length, 0)
        assert.equal(readFileSync(join(root, snapshotPath), 'utf8'), snapshot)
        assert.deepEqual((await readdir(join(root, 'database/migrations'))).sort(), files)
      }
      assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
      assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
      console.log('PASS fresh current custody upgrade preserves projections and requires explicit constrained enrollment')
    }
  }
  finally { await database.closeDatabaseConnection() }
}
else assert.fail(`Unknown fixture phase ${mode}`)
