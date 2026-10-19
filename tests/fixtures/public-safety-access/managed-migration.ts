import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { retainedPreview } from '../../helpers/public-safety-retained'

const root = realpathSync(process.cwd()), source = resolve(import.meta.dir, '../../..')
assert(basename(root).startsWith('drone-incident-access-managed-upgrade-'))
assert.equal(join(realpathSync(dirname(process.env.DB_DATABASE_PATH!)), basename(process.env.DB_DATABASE_PATH!)), join(root, 'access.sqlite'))
const oldCommit = '4e42cd275f247fbbf487340a1231305cb18fea7d'
const archive = join(root, 'old-source'), evidence = join(root, 'old-source-evidence.json')
const snapshotPath = 'storage/framework/database/model-snapshot.sqlite.json'
const tables = ['public_safety_incidents', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_sources', 'public_safety_observations', 'public_safety_reviews', 'public_safety_retention_scopes', 'public_safety_retention_events']
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
    const child = Bun.spawn([process.execPath, `--config=${join(root, 'bunfig.toml')}`, '--no-env-file', import.meta.path, phase], { cwd: root, env: { ...process.env, MANAGED_OLD_SCHEMA: phase === 'seed' ? '1' : '0', MANAGED_REUSE_DATABASE: phase === 'seed' ? '0' : '1' }, stdout: 'pipe', stderr: 'pipe' })
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
  console.log('PASS managed generated schema upgrade preserves actual old source, membership and audit rows and is twice a no-op')
}
else if (mode === 'seed') {
  assert.equal(process.env.MANAGED_OLD_SCHEMA, '1')
  const { database, actor, as, access, records } = await import(join(archive, 'tests/fixtures/public-safety-access/managed-context.ts')) as typeof import('./managed-context')
  try {
    const coordinator = await actor('managed-upgrade')
    await as(coordinator.token.plainTextToken, async () => {
      const { examplePublicSafetyConfig } = await import(join(archive, 'resources/functions/drone/public-safety/fixtures.ts')) as typeof import('../../../resources/functions/drone/public-safety/fixtures')
      const { simulatePublicSafety } = await import(join(archive, 'resources/functions/drone/public-safety/runtime.ts')) as typeof import('../../../resources/functions/drone/public-safety/runtime')
      const config = examplePublicSafetyConfig(); config.id = 'managed-upgrade'; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
      await access.createPublicSafetyIncident({ config })
      const registered = await records.registerPublicSafetySource(config.id, { expectedVersion: 1, recording: simulatePublicSafety({ config, seconds: 10 }) })
      assert.deepEqual(await database.db.unsafe("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'public_safety_managed_%'"), [], 'Old DB genuinely predates all three managed tables')
      const columns = await database.db.unsafe('PRAGMA table_info(public_safety_retention_scopes)') as { name: string }[]
      assert(!columns.some(column => column.name === 'freeze_state'), 'Historical custody schema predates C freeze state')
      const rows = Object.fromEntries(await Promise.all(tables.map(async table => [table, await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute()])))
      for (const table of tables.slice(0, 4)) assert(rows[table].length > 0, `${table} requires actual historical data`)
      await writeFile(evidence, JSON.stringify({ rows, ledger: await database.db.unsafe('SELECT * FROM migrations ORDER BY id'), token: coordinator.token.plainTextToken, sourceDigest: registered.source.digest }))
      assert.equal(readFileSync(join(root, snapshotPath), 'utf8'), readFileSync(join(archive, snapshotPath), 'utf8'))
      assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
      assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
    })
    console.log('PASS actual archived B services create the pre-managed source schema and evidence')
  }
  finally { await database.closeDatabaseConnection() }
}
else if (mode === 'upgrade') {
  assert.equal(process.env.MANAGED_OLD_SCHEMA, '0')
  const { database, as, managed, retention } = await import('./managed-context')
  try {
    const before = JSON.parse(readFileSync(evidence, 'utf8')) as { rows: Record<string, unknown[]>, ledger: unknown[], token: string, sourceDigest: string }
    const result = await database.runDatabaseMigration(); if (result.isErr) throw result.error
    assert.deepEqual(Object.fromEntries(await Promise.all(tables.map(async table => [table, await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute()]))), before.rows, 'Actual B+C upgrade preserves all historical row IDs and values')
    const ledger = await database.db.unsafe('SELECT * FROM migrations ORDER BY id')
    assert.deepEqual(ledger.slice(0, before.ledger.length), before.ledger)
    assert.equal(ledger.length - before.ledger.length, 7, 'All three B and four C pending generated migrations actually apply')
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
    assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_keys'), [{ foreign_keys: 1 }])
    for (const table of ['public_safety_managed_artifacts', 'public_safety_managed_artifact_files', 'public_safety_managed_artifact_events', 'public_safety_purges', 'public_safety_purge_items', 'public_safety_purge_events']) assert.deepEqual(await database.db.primary.selectFrom(table).selectAll().execute(), [], 'Upgrade alone creates no managed artifact or accepted purge')
    await as(before.token, async () => {
      const preview = retainedPreview(await retention.previewPublicSafetyRetention('managed-upgrade'))
      await retention.enrollPublicSafetyRetention('managed-upgrade', { expectedVersion: 2, policyVersion: 'local-managed-v1', inventoryDigest: preview.inventoryDigest, requestId: randomUUID() })
      const created = await managed.createPublicSafetyManagedDataset('managed-upgrade', { expectedVersion: 3, expectedRetentionVersion: 1, sourceDigest: before.sourceDigest, datasetProfile: 'owned-public-safety-dataset-v1', requestId: randomUUID() })
      assert.equal(created.artifact.state, 'complete')
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
    console.log('PASS fresh current process applies real B+C migrations and publishes a source-derived managed dataset')
  }
  finally { await database.closeDatabaseConnection() }
}
else assert.fail(`Unknown fixture phase ${mode}`)
