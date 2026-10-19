import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { setupIncidentDatabase } from './setup'
import { retainedPreview } from '../../helpers/public-safety-retained'

const root = realpathSync(process.cwd())
assert(basename(root).startsWith('drone-incident-access-purge-migration-'))
assert.equal(join(realpathSync(dirname(process.env.DB_DATABASE_PATH!)), basename(process.env.DB_DATABASE_PATH!)), join(root, 'access.sqlite'))
const source = resolve(import.meta.dir, '../../..')
const oldCommit = '4e42cd275f247fbbf487340a1231305cb18fea7d'
const mode = process.argv[2]!, state = process.argv[3]!
const archive = join(root, 'old-source'), beforePath = join(root, 'before.json')
const snapshotPath = 'storage/framework/database/model-snapshot.sqlite.json'
const oldTables = ['public_safety_incidents', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_sources', 'public_safety_observations', 'public_safety_reviews', 'public_safety_retention_scopes', 'public_safety_retention_events', 'public_safety_managed_artifacts', 'public_safety_managed_artifact_files', 'public_safety_managed_artifact_events']
function tree() {
  const directory = join(root, 'managed-private')
  return !existsSync(directory) ? [] : ['', ...readdirSync(directory, { recursive: true }).map(String).sort()].map(name => {
    const path = join(directory, name), stat = lstatSync(path, { bigint: true })
    assert(!stat.isSymbolicLink())
    return { name, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), nlink: String(stat.nlink), birthtimeNs: String(stat.birthtimeNs), size: stat.isFile() ? String(stat.size) : null, sha256: stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null }
  })
}
if (mode === 'stage') {
  const checked = Bun.spawnSync(['git', 'cat-file', '-e', `${oldCommit}^{commit}`], { cwd: source, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(checked.exitCode, 0, 'Pinned old B Git object is required; CI must fetch full history')
  await mkdir(archive)
  const exported = Bun.spawnSync(['git', 'archive', oldCommit, 'app/Models', 'database/migrations', snapshotPath, 'resources/functions', 'tests/fixtures/public-safety-access'], { cwd: source, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(exported.exitCode, 0, exported.stderr.toString())
  const unpacked = Bun.spawnSync(['tar', '-xf', '-', '-C', archive], { stdin: exported.stdout, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(unpacked.exitCode, 0, unpacked.stderr.toString())
  await mkdir(join(archive, 'storage/framework'), { recursive: true })
  await symlink(join(source, 'storage/framework/defaults'), join(archive, 'storage/framework/defaults'))
  await symlink(join(source, 'node_modules'), join(archive, 'node_modules'))
  console.log('PASS immutable published B archive staged inside guarded disposable root')
}
else if (mode === 'seed' || mode === 'reconcile') {
  if (mode === 'reconcile') process.env.MANAGED_REUSE_DATABASE = '1'
  const context = await import(join(archive, 'tests/fixtures/public-safety-access/managed-context.ts')) as typeof import('./managed-context')
  const { database, actor, as, access, records, retention, managed } = context
  try {
    if (mode === 'seed') {
      const coordinator = await actor('purge-upgrade')
      await as(coordinator.token.plainTextToken, async () => {
        const { examplePublicSafetyConfig } = await import(join(archive, 'resources/functions/drone/public-safety/fixtures.ts')) as typeof import('../../../resources/functions/drone/public-safety/fixtures')
        const { simulatePublicSafety } = await import(join(archive, 'resources/functions/drone/public-safety/runtime.ts')) as typeof import('../../../resources/functions/drone/public-safety/runtime')
        const config = examplePublicSafetyConfig(); config.id = `upgrade-${state}`; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
        await access.createPublicSafetyIncident({ config })
        const registered = await records.registerPublicSafetySource(config.id, { expectedVersion: 1, recording: simulatePublicSafety({ config, seconds: 10 }) })
        const observation = await records.appendPublicSafetyObservation(config.id, { expectedVersion: 2, sourceDigest: registered.source.digest, captureId: 'photo-0001', modality: 'visible', pixel: { x: 0, y: 71 }, note: 'Old B private migration observation', uncertaintyNote: 'Old B uncertainty retained exactly' })
        await records.appendPublicSafetyReview(config.id, observation.observation.id, { expectedVersion: 3, sourceDigest: registered.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Old B private migration review' })
        const preview = retainedPreview(await retention.previewPublicSafetyRetention(config.id))
        await retention.enrollPublicSafetyRetention(config.id, { expectedVersion: 4, policyVersion: 'local-managed-v1', inventoryDigest: preview.inventoryDigest, requestId: randomUUID() })
        writeFileSync(join(root, 'credentials.json'), JSON.stringify({ token: coordinator.token.plainTextToken, key: config.id }))
        const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
        let action = ''
        const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
          const sql = event.sql.replace(/["`]/g, '').toLowerCase()
          if (sql.startsWith('insert into public_safety_managed_artifact_events')) {
            for (const value of ['intent-recorded', 'ownership-recorded']) if (event.params?.includes(value)) action = value
            if (state === 'blocked' && action === 'ownership-recorded') pause()
          }
          if (sql.startsWith('select distinct permissions') && (state === 'intent' && action === 'intent-recorded' || (state === 'prepared' || state === 'interrupted') && action === 'ownership-recorded')) pause()
        } })
        function pause() { writeFileSync(join(root, 'kill-ready'), state); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000); throw new Error('Parent must terminate the child at the actual native barrier') }
        try { assert.equal((await managed.createPublicSafetyManagedDataset(config.id, { expectedVersion: 5, expectedRetentionVersion: 1, sourceDigest: registered.source.digest, datasetProfile: 'owned-public-safety-dataset-v1', requestId: randomUUID() })).artifact.state, 'complete'); assert.equal(state, 'complete') }
        finally { unhook() }
      })
    }
    else {
      const saved = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8')) as { token: string, key: string }
      await as(saved.token, async () => {
        const row = (await database.db.primary.selectFrom('public_safety_managed_artifacts').selectAll().execute())[0]!
        assert(typeof row.artifact_key === 'string' && typeof row.version === 'number')
        const incident = await access.readPublicSafetyIncident(saved.key)
        const result = await managed.reconcilePublicSafetyManagedArtifact(saved.key, row.artifact_key, { expectedVersion: incident.version, expectedArtifactVersion: row.version, requestId: randomUUID() })
        assert.equal(result.artifact.state, state)
      })
    }
    console.log(`PASS actual old B public service ${state}`)
  }
  finally { await database.closeDatabaseConnection() }
}
else if (mode === 'capture') {
  const db = new Database(process.env.DB_DATABASE_PATH!, { readonly: true })
  try {
    const rows = Object.fromEntries(oldTables.map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY id`).all()]))
    const artifacts = rows.public_safety_managed_artifacts as { state: string }[]
    assert.equal(artifacts.length, 1); assert.equal(artifacts[0]!.state, state)
    for (const table of oldTables) assert(rows[table]!.length > 0, `${table} must contain real B data`)
    const oldColumns = db.query('PRAGMA table_info(public_safety_managed_artifacts)').all() as { name: string, notnull: number }[]
    assert.equal(oldColumns.find(column => column.name === 'source_id')!.notnull, 1)
    const oldScopeColumns = db.query('PRAGMA table_info(public_safety_retention_scopes)').all() as { name: string }[]
    assert(!oldScopeColumns.some(column => column.name === 'freeze_state'))
    assert.deepEqual(db.query('PRAGMA foreign_key_check').all(), [])
    assert.deepEqual(db.query('PRAGMA integrity_check').all(), [{ integrity_check: 'ok' }])
    writeFileSync(beforePath, JSON.stringify({ rows, tree: tree(), ledger: db.query('SELECT * FROM migrations ORDER BY id').all() }))
    assert.equal(existsSync(join(root, snapshotPath)), true)
    assert.equal(readFileSync(join(root, snapshotPath), 'utf8'), readFileSync(join(archive, snapshotPath), 'utf8'))
  }
  finally { db.close() }
  console.log(`PASS exact old B rows and namespace captured for ${state}`)
}
else if (mode === 'upgrade') {
  // setup copies only app definitions and immutable SQL into this already guarded disposable root.
  // A fresh process gives the native registry the actual current C model definitions.
  const { database } = await setupIncidentDatabase({ reuseDatabase: true })
  try {
    const before = JSON.parse(readFileSync(beforePath, 'utf8')) as { rows: Record<string, Record<string, unknown>[]>, tree: ReturnType<typeof tree>, ledger: { id: number, migration: string }[] }
    const oldCorpus = new Set(readdirSync(join(archive, 'database/migrations')))
    const pending = readdirSync(join(root, 'database/migrations')).filter(name => name.endsWith('.sql') && !oldCorpus.has(name) && !before.ledger.some(entry => entry.migration === name)).sort()
    assert(pending.includes('1789486698579-auto-misc.sql'), 'Actual handover audit rebuild must apply to this historical schema')
    const migration = await database.runDatabaseMigration(); if (migration.isErr) throw migration.error
    for (const table of oldTables) {
      const rows = await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute() as Record<string, unknown>[]
      if (table === 'public_safety_retention_scopes') for (const row of rows) { assert.equal(row.freeze_state, 'retained'); delete row.freeze_state }
      if (table === 'public_safety_audits') for (const row of rows) for (const field of ['handover_key', 'handover_step', 'handover_assignment_version', 'request_id', 'request_digest']) { assert.equal(row[field], null, `${field} must remain NULL on historical audit rows`); delete row[field] }
      assert.deepEqual(rows, before.rows[table], `${table} identity and every old value must survive native C migration`)
    }
    assert.deepEqual(tree(), before.tree, 'Migration must preserve exact registered and unregistered filesystem identities and bytes')
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
    assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_keys'), [{ foreign_keys: 1 }])
    for (const table of ['public_safety_purges', 'public_safety_purge_events', 'public_safety_purge_items']) assert.deepEqual(await database.db.primary.selectFrom(table).selectAll().execute(), [], 'Upgrade never accepts or executes purge')
    const incidentColumns = await database.db.unsafe('PRAGMA table_info(public_safety_incidents)') as { name: string, notnull: number }[]
    for (const name of ['config_json', 'purpose', 'revision']) assert.equal(incidentColumns.find(column => column.name === name)!.notnull, 0)
    const artifactColumns = await database.db.unsafe('PRAGMA table_info(public_safety_managed_artifacts)') as { name: string, notnull: number }[]
    assert.equal(artifactColumns.find(column => column.name === 'source_id')!.notnull, 0)
    const foreignKeys = await database.db.unsafe('PRAGMA foreign_key_list(public_safety_managed_artifacts)') as { from: string, on_delete: string }[]
    assert.equal(foreignKeys.find(key => key.from === 'source_id')!.on_delete, 'SET NULL')
    // Exercise the new schema behavior in a real native transaction, then roll it back.
    // This is a schema probe, not execution of an accepted purge.
    const { transaction } = await import('@stacksjs/orm')
    const rollback = new Error('Rollback disposable migration behavior probe')
    await assert.rejects(() => transaction(async tx => {
      await tx.deleteFrom('public_safety_reviews').execute()
      await tx.deleteFrom('public_safety_observations').execute()
      await tx.deleteFrom('public_safety_sources').execute()
      assert.equal((await tx.selectFrom('public_safety_managed_artifacts').select('source_id').executeTakeFirst())!.source_id, null)
      await tx.updateTable('public_safety_incidents').set({ config_json: null, purpose: null, revision: null, status: 'purged' }).execute()
      await tx.updateTable('public_safety_retention_scopes').set({ freeze_state: 'frozen' }).execute()
      assert.equal((await tx.selectFrom('public_safety_incidents').select('config_json').executeTakeFirst())!.config_json, null)
      assert.equal((await tx.selectFrom('public_safety_retention_scopes').select('freeze_state').executeTakeFirst())!.freeze_state, 'frozen')
      throw rollback
    }, { retries: 0 }), error => error === rollback)
    for (const table of oldTables) {
      const rows = await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute() as Record<string, unknown>[]
      if (table === 'public_safety_retention_scopes') for (const row of rows) { assert.equal(row.freeze_state, 'retained'); delete row.freeze_state }
      if (table === 'public_safety_audits') for (const row of rows) for (const field of ['handover_key', 'handover_step', 'handover_assignment_version', 'request_id', 'request_digest']) { assert.equal(row[field], null, `${field} must remain NULL on historical audit rows`); delete row[field] }
      assert.deepEqual(rows, before.rows[table], 'Native rollback preserves every old row after SET NULL/nullable/freeze probes')
    }
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
    const ledger = await database.db.unsafe('SELECT * FROM migrations ORDER BY id') as { id: number, migration: string }[]
    assert.deepEqual(ledger.slice(0, before.ledger.length), before.ledger)
    assert.deepEqual(ledger.slice(before.ledger.length).map(entry => entry.migration).sort(), pending, 'Exact new corpus SQL names match actual native ledger additions')
    const snapshot = readFileSync(join(root, snapshotPath), 'utf8'), files = readdirSync(join(root, 'database/migrations')).sort()
    assert.equal(snapshot, readFileSync(join(source, snapshotPath), 'utf8'))
    for (let pass = 0; pass < 2; pass++) {
      const result = await database.generateMigrations(); if (result.isErr) throw result.error
      assert.equal((await database.pendingMigrationOperations()).length, 0)
      assert.deepEqual(readdirSync(join(root, 'database/migrations')).sort(), files)
      assert.equal(readFileSync(join(root, snapshotPath), 'utf8'), snapshot)
    }
    console.log(`PASS actual published B ${state} schema/data upgrade is lossless with exact C snapshot and twice no-op native generation`)
  }
  finally { await database.closeDatabaseConnection() }
}
else assert.fail(`Unknown mode ${mode}`)
