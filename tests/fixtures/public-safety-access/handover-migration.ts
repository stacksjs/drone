import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

// Historical services must accept the real C plan before the current audit schema is loaded.
const root = realpathSync(process.cwd()), source = resolve(import.meta.dir, '../../..')
assert(basename(root).startsWith('drone-incident-access-handover-upgrade-'))
assert.equal(join(realpathSync(dirname(process.env.DB_DATABASE_PATH!)), basename(process.env.DB_DATABASE_PATH!)), join(root, 'access.sqlite'))
const oldCommit = '8990a0b4a317110e7872fd68266753a6067b6528'
const archive = join(root, 'old-source'), evidencePath = join(root, 'accepted-c-evidence.json')
const snapshotPath = 'storage/framework/database/model-snapshot.sqlite.json'
const fields = ['handover_key', 'handover_step', 'handover_assignment_version', 'request_id', 'request_digest']
const tables = ['public_safety_incidents', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_sources', 'public_safety_observations', 'public_safety_reviews', 'public_safety_retention_scopes', 'public_safety_retention_events', 'public_safety_purges', 'public_safety_purge_items', 'public_safety_purge_events']
const mode = process.argv[2]
type Rows = Record<string, Record<string, unknown>[]>
interface Evidence { rows: Rows, ledger: Record<string, unknown>[], token: string, command: Record<string, unknown>, accepted: Record<string, unknown>, ownedId: number, siblingId: number, purgeKey: string }
if (mode === 'stage') {
  assert.equal(Bun.spawnSync(['git', 'cat-file', '-e', `${oldCommit}^{commit}`], { cwd: source, stdout: 'pipe', stderr: 'pipe' }).exitCode, 0, 'Pinned published C Git object required; fetch full history in CI')
  await mkdir(archive)
  const exported = Bun.spawnSync(['git', 'archive', oldCommit, 'app/Models', 'app/Jobs', 'database/migrations', snapshotPath, 'resources/functions', 'tests/fixtures/public-safety-access', 'tests/helpers'], { cwd: source, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(exported.exitCode, 0, exported.stderr.toString())
  const unpacked = Bun.spawnSync(['tar', '-xf', '-', '-C', archive], { stdin: exported.stdout, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(unpacked.exitCode, 0, unpacked.stderr.toString())
  await mkdir(join(archive, 'storage/framework'), { recursive: true })
  await symlink(join(source, 'storage/framework/defaults'), join(archive, 'storage/framework/defaults'))
  await symlink(join(source, 'node_modules'), join(archive, 'node_modules'))
  console.log('PASS archived published C models code SQL and snapshot staged')
}
else if (mode === 'seed') {
  const context = await import(join(archive, 'tests/fixtures/public-safety-access/managed-context.ts')) as typeof import('./managed-context')
  const { database, actor, as, seed, records } = context
  const purge = await import(join(archive, 'resources/functions/drone/public-safety/purge/service.ts')) as typeof import('../../../resources/functions/drone/public-safety/purge/service')
  const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import(join(archive, 'resources/functions/drone/public-safety/purge/types.ts')) as typeof import('../../../resources/functions/drone/public-safety/purge/types')
  const { publicSafetyPurgeGate } = await import(join(archive, 'resources/functions/drone/public-safety/purge/policy.ts')) as typeof import('../../../resources/functions/drone/public-safety/purge/policy')
  const { Gate } = await import('@stacksjs/auth/gate')
  for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
  try {
    process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
    const coordinator = await actor('historical-handover')
    await as(coordinator.token.plainTextToken, async () => {
      const fixture = await seed('historical-handover', 7000)
      const capture = fixture.run.survey.captures[0]!, support = fixture.run.captures[0]!.support.findIndex(value => value === 1)
      const observation = await records.appendPublicSafetyObservation(fixture.config.id, { expectedVersion: 3, sourceDigest: fixture.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'Historical C observation survives the native audit rebuild', uncertaintyNote: 'Historical C original uncertainty' })
      await records.appendPublicSafetyReview(fixture.config.id, observation.observation.id, { expectedVersion: 4, sourceDigest: fixture.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Historical C review survives exactly' })
      await seed('historical-sibling')
      const columns = await database.db.unsafe('PRAGMA table_info(public_safety_audits)') as { name: string }[]
      for (const field of fields) assert(!columns.some(column => column.name === field), `Historical C must genuinely predate ${field}`)
      assert.equal(readFileSync(join(root, snapshotPath), 'utf8'), readFileSync(join(archive, snapshotPath), 'utf8'))
      const wait = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 20
      if (wait > 0) await Bun.sleep(wait)
      const preview = await purge.previewPublicSafetyPurge(fixture.config.id)
      const command = { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() }
      const accepted = await purge.acceptPublicSafetyPurge(fixture.config.id, command)
      assert.equal(accepted.purge.state, 'building')
      assert.equal(accepted.purge.planned.audits, 4)
      const rows: Rows = Object.fromEntries(await Promise.all(tables.map(async table => [table, await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute()])))
      const ownedId = rows.public_safety_incidents!.find(row => row.incident_key === fixture.config.id)!.id as number
      const siblingId = rows.public_safety_incidents!.find(row => row.incident_key === 'historical-sibling')!.id as number
      const plan = rows.public_safety_purges![0]!
      assert.equal(plan.frozen_inventory_digest, command.inventoryDigest)
      assert.equal(plan.frozen_counts_json, JSON.stringify(accepted.purge.planned))
      assert.notEqual(plan.frozen_header_json, '{}')
      await writeFile(evidencePath, JSON.stringify({ rows, ledger: await database.db.unsafe('SELECT * FROM migrations ORDER BY id'), token: coordinator.token.plainTextToken, command, accepted, ownedId, siblingId, purgeKey: accepted.purge.purgeKey }), { mode: 0o600 })
      assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
      assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
    })
    console.log('PASS genuine pre-handover C schema accepts immutable v1 purge before migration')
  }
  finally { await database.closeDatabaseConnection() }
}
else if (mode === 'upgrade') {
  process.env.MANAGED_REUSE_DATABASE = '1'
  const { database, as } = await import('./managed-context')
  const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
  const { purgeAbilities } = await import('../../../resources/functions/drone/public-safety/purge/types')
  const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
  const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
  const { Gate } = await import('@stacksjs/auth/gate')
  for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
  try {
    process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
    const before = JSON.parse(readFileSync(evidencePath, 'utf8')) as Evidence
    const migrated = await database.runDatabaseMigration(); if (migrated.isErr) throw migrated.error
    const columns = await database.db.unsafe('PRAGMA table_info(public_safety_audits)') as { name: string, notnull: number, dflt_value: unknown }[]
    for (const field of fields) {
      const column = columns.find(column => column.name === field)
      assert(column, `Generated handover migration must add ${field}`)
      assert.equal(column.notnull, 0); assert.equal(column.dflt_value, null)
    }
    for (const table of tables) {
      const rows = await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute() as Record<string, unknown>[]
      if (table === 'public_safety_audits') for (const row of rows) for (const field of fields) { assert.equal(row[field], null); delete row[field] }
      assert.deepEqual(rows, before.rows[table], `${table}: exact historical row IDs and values survive the actual generated rebuild`)
    }
    const ledger = await database.db.unsafe('SELECT * FROM migrations ORDER BY id') as Record<string, unknown>[]
    assert.deepEqual(ledger.slice(0, before.ledger.length), before.ledger)
    assert(ledger.length > before.ledger.length, 'Actual generated migration must run, not an already-new schema')
    const oldPlan = before.rows.public_safety_purges![0]!
    const currentPlan = (await database.db.primary.selectFrom('public_safety_purges').selectAll().executeTakeFirst())!
    for (const field of ['request_id', 'request_digest', 'frozen_header_json', 'frozen_counts_json', 'frozen_inventory_digest', 'accepted_incident_version', 'accepted_retention_version']) assert.deepEqual(currentPlan[field], oldPlan[field], `${field} remains exactly accepted v1`)
    const indexes = await database.db.unsafe('PRAGMA index_list(public_safety_audits)') as { name: string, unique: number }[]
    const indexed = await Promise.all(indexes.map(async index => ({ ...index, columns: (await database.db.unsafe(`PRAGMA index_info(${index.name})`) as { name: string }[]).map(column => column.name) })))
    for (const columns of [['incident_id', 'sequence'], ['incident_id', 'handover_key', 'handover_step'], ['incident_id', 'request_id']]) assert(indexed.some(index => index.unique === 1 && JSON.stringify(index.columns) === JSON.stringify(columns)), `Unique index preserved/generated: ${columns}`)
    assert(indexed.some(index => JSON.stringify(index.columns) === JSON.stringify(['incident_id', 'actor_id', 'handover_assignment_version', 'action', 'sequence'])))
    const legacy = before.rows.public_safety_audits![0]!, { id, ...duplicate } = legacy
    assert(id)
    await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values(duplicate).execute(), /UNIQUE constraint failed/)
    await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values({ ...duplicate, sequence: 2147483640, action: 'not-a-valid-action' }).execute(), /CHECK constraint failed/)
    await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values({ ...duplicate, incident_id: 2147483647 }).execute(), /FOREIGN KEY constraint failed/)
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_keys'), [{ foreign_keys: 1 }])
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
    assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
    const snapshot = readFileSync(join(root, snapshotPath), 'utf8'), files = (await readdir(join(root, 'database/migrations'))).sort()
    assert.equal(snapshot, readFileSync(join(source, snapshotPath), 'utf8'))
    for (let pass = 0; pass < 2; pass++) {
      const generated = await database.generateMigrations(); if (generated.isErr) throw generated.error
      assert.equal((await database.pendingMigrationOperations()).length, 0)
      assert.equal(readFileSync(join(root, snapshotPath), 'utf8'), snapshot)
      assert.deepEqual((await readdir(join(root, 'database/migrations'))).sort(), files)
    }
    await as(before.token, async () => {
      const replay = await purge.acceptPublicSafetyPurge('historical-handover', before.command)
      assert.equal(replay.replayed, true)
      assert.deepEqual(replay.purge, before.accepted.purge)
      let current = replay.purge
      for (let pass = 0; pass < 60 && current.state !== 'complete'; pass++) {
        await job.dispatchNow({ purgeKey: before.purgeKey })
        current = await purge.readPublicSafetyPurge('historical-handover', before.purgeKey)
        assert.notEqual(current.state, 'blocked', JSON.stringify(current))
      }
      assert.equal(current.state, 'complete')
      assert.equal(current.inventoryDigest, oldPlan.frozen_inventory_digest)
      assert.equal(JSON.stringify(current.planned), oldPlan.frozen_counts_json)
      assert.equal(current.completed.auditRowsRemoved, current.planned.audits)
      assert.equal(current.completed.sourceRowsRemoved, 1)
      assert.equal(current.completed.observationRowsRemoved, 1)
      assert.equal(current.completed.reviewRowsRemoved, 1)
      assert.equal(current.completed.namesUnlinked, 0)
    })
    for (const table of ['public_safety_audits', 'public_safety_sources']) assert.deepEqual(await database.db.primary.selectFrom(table).select('id').where('incident_id', '=', before.ownedId).execute(), [])
    for (const table of ['public_safety_incidents', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_sources', 'public_safety_retention_scopes']) {
      const column = table === 'public_safety_incidents' ? 'id' : 'incident_id'
      const rows = await database.db.primary.selectFrom(table).selectAll().where(column, '=', before.siblingId).orderBy('id', 'asc').execute() as Record<string, unknown>[]
      if (table === 'public_safety_audits') for (const row of rows) for (const field of fields) { assert.equal(row[field], null); delete row[field] }
      assert.deepEqual(rows, before.rows[table]!.filter(row => row[column] === before.siblingId), `${table}: unrelated sibling remains exact`)
    }
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
    assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
    console.log('PASS actual archived accepted C purge survives native handover migration and twice-no-op generation with exact legacy IDs and consent')
    console.log('PASS resumed awaited native purge Job removes accepted DB payload without filesystem deletion claims')
  }
  finally { await database.closeDatabaseConnection() }
}
else assert.fail(`Unknown fixture phase ${mode}`)
