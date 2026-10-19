import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

// Seed with published access-era models/code/SQL, then upgrade in a fresh process.
// Withholding only records SQL from today's corpus applies later rebuilds out of order.
const root = realpathSync(process.cwd()), source = resolve(import.meta.dir, '../../..')
assert(basename(root).startsWith('drone-incident-access-'))
assert.equal(join(realpathSync(dirname(process.env.DB_DATABASE_PATH!)), basename(process.env.DB_DATABASE_PATH!)), join(root, 'access.sqlite'))
const oldCommit = 'dbe3a509f0830fd08ca38dc094c178e7a739fc41'
const archive = join(root, 'old-source'), evidence = join(root, 'old-access-evidence.json')
const snapshotPath = 'storage/framework/database/model-snapshot.sqlite.json'
const tables = ['public_safety_incidents', 'public_safety_incident_members', 'public_safety_audits']
const fields = ['handover_key', 'handover_step', 'handover_assignment_version', 'request_id', 'request_digest']
const mode = process.argv[2]
type Rows = Record<string, Record<string, unknown>[]>
interface Index { name: string, unique: number, columns: string[] }

if (!mode) {
  assert.equal(Bun.spawnSync(['git', 'cat-file', '-e', `${oldCommit}^{commit}`], { cwd: source, stdout: 'pipe', stderr: 'pipe' }).exitCode, 0, 'Pinned published access Git object required; CI must fetch full history')
  await mkdir(archive)
  const exported = Bun.spawnSync(['git', 'archive', oldCommit, 'app/Models', 'database/migrations', snapshotPath, 'resources/functions', 'tests/fixtures/public-safety-access'], { cwd: source, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(exported.exitCode, 0, exported.stderr.toString())
  const unpacked = Bun.spawnSync(['tar', '-xf', '-', '-C', archive], { stdin: exported.stdout, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(unpacked.exitCode, 0, unpacked.stderr.toString())
  await mkdir(join(archive, 'storage/framework'), { recursive: true })
  await symlink(join(source, 'storage/framework/defaults'), join(archive, 'storage/framework/defaults'))
  await symlink(join(source, 'node_modules'), join(archive, 'node_modules'))
  for (const phase of ['seed', 'upgrade']) {
    const child = Bun.spawn([process.execPath, `--config=${join(root, 'bunfig.toml')}`, '--no-env-file', import.meta.path, phase], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 60000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, `${phase}\n${stdout}\n${stderr}`)
      console.log(stdout)
    }
    finally {
      clearTimeout(timeout)
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    }
  }
  console.log('PASS native access data survives generated observation schema upgrade')
}
else if (mode === 'seed' || mode === 'upgrade') {
  const codeRoot = mode === 'seed' ? archive : source
  const { setupIncidentDatabase } = await import(join(codeRoot, 'tests/fixtures/public-safety-access/setup.ts')) as typeof import('./setup')
  const { database, User } = await setupIncidentDatabase({ reuseDatabase: mode === 'upgrade' })
  const access = await import(join(codeRoot, 'resources/functions/drone/public-safety/access/service.ts')) as typeof import('../../../resources/functions/drone/public-safety/access/service')
  // Access-era fixtures declared this exact list before incidentAbilities became a runtime export.
  const incidentAbilities = mode === 'seed' ? ['view', 'audit', 'manage-members', 'close'] as const : (await import('../../../resources/functions/drone/public-safety/access/types')).incidentAbilities
  const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import(join(codeRoot, 'resources/functions/drone/public-safety/access/policy.ts')) as typeof import('../../../resources/functions/drone/public-safety/access/policy')
  const { Gate } = await import('@stacksjs/auth/gate')
  const { Rbac } = await import('@stacksjs/auth/rbac')
  const { createToken } = await import('@stacksjs/auth/tokens')
  const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
  const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
  setAmbientRequestContext(true)
  Gate.define('public-safety:create', publicSafetyCreateGate)
  for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
  const as = <T>(token: string, work: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), work)
  const projection = async () => ({ incident: await access.readPublicSafetyIncident('upgrade-records'), audit: await access.readPublicSafetyAudit('upgrade-records') })
  const indexes = async (): Promise<Index[]> => {
    const entries = await database.db.unsafe('PRAGMA index_list(public_safety_audits)') as { name: string, unique: number }[]
    return Promise.all(entries.map(async index => ({ name: index.name, unique: index.unique, columns: (await database.db.unsafe(`PRAGMA index_info(${index.name})`) as { name: string }[]).map(column => column.name) })))
  }
  try {
    if (mode === 'seed') {
      const coordinator = await User.create({ name: 'Migration Coordinator', email: 'migration-coordinator@example.invalid', password: 'temporary-fixture-password' })
      const member = await User.create({ name: 'Existing Member', email: 'existing-member@example.invalid', password: 'temporary-fixture-password' })
      for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(coordinator.id, permission, 'web') }
      const credential = await createToken(coordinator.id, 'upgrade fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
      const { examplePublicSafetyConfig } = await import(join(archive, 'resources/functions/drone/public-safety/fixtures.ts')) as typeof import('../../../resources/functions/drone/public-safety/fixtures')
      const config = examplePublicSafetyConfig(); config.id = 'upgrade-records'; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
      await as(credential.plainTextToken, async () => {
        await access.createPublicSafetyIncident({ config })
        await access.changePublicSafetyMembership(config.id, { expectedVersion: 1, userId: member.id, role: 'pilot' })
        const rows: Rows = Object.fromEntries(await Promise.all(tables.map(async table => [table, await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute()])))
        for (const table of tables) assert(rows[table]!.length > 0, `${table} requires genuine historical rows`)
        assert.deepEqual(await database.db.unsafe("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('public_safety_sources','public_safety_observations','public_safety_reviews')"), [], 'Published access database genuinely predates all three records tables')
        const columns = await database.db.unsafe('PRAGMA table_info(public_safety_audits)') as { name: string }[]
        for (const field of fields) assert(!columns.some(column => column.name === field), `Historical schema must predate ${field}`)
        assert.equal(readFileSync(join(root, snapshotPath), 'utf8'), readFileSync(join(archive, snapshotPath), 'utf8'))
        await writeFile(evidence, JSON.stringify({ rows, ledger: await database.db.unsafe('SELECT * FROM migrations ORDER BY id'), columns: columns.map(column => column.name), indexes: await indexes(), foreignKeys: await database.db.unsafe('PRAGMA foreign_key_list(public_safety_audits)'), token: credential.plainTextToken, config, projection: await projection() }), { mode: 0o600 })
        assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
        assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
      })
      console.log('PASS archived published access code seeds genuine pre-records rows and exact evidence')
    }
    else {
      const before = JSON.parse(readFileSync(evidence, 'utf8')) as { rows: Rows, ledger: { migration: string }[], columns: string[], indexes: Index[], foreignKeys: unknown[], token: string, config: unknown, projection: Awaited<ReturnType<typeof projection>> }
      const oldCorpus = new Set(await readdir(join(archive, 'database/migrations')))
      const pending = (await readdir(join(root, 'database/migrations'))).filter(name => name.endsWith('.sql') && !oldCorpus.has(name) && !before.ledger.some(entry => entry.migration === name)).sort()
      assert.equal(pending.length, 14, 'All actual records-through-handover SQL must run in this upgrade')
      assert(pending[0]!.startsWith('1789486698566-')); assert.equal(pending.at(-1), '1789486698579-auto-misc.sql')
      const migrated = await database.runDatabaseMigration(); if (migrated.isErr) throw migrated.error
      const ledger = await database.db.unsafe('SELECT * FROM migrations ORDER BY id') as { migration: string }[]
      assert.deepEqual(ledger.slice(0, before.ledger.length), before.ledger)
      assert.deepEqual(ledger.slice(before.ledger.length).map(entry => entry.migration), pending, 'Native runner applies exact current SQL in true 8566..8579 order')
      const columns = await database.db.unsafe('PRAGMA table_info(public_safety_audits)') as { name: string, notnull: number, dflt_value: unknown }[]
      assert.deepEqual(columns.map(column => column.name).sort(), [...before.columns, ...fields].sort(), 'Only the five declared audit fields may be added')
      for (const field of fields) {
        const column = columns.find(column => column.name === field)!
        assert.equal(column.notnull, 0); assert.equal(column.dflt_value, null)
      }
      for (const table of tables) {
        const rows = await database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute() as Record<string, unknown>[]
        if (table === 'public_safety_audits') for (const row of rows) for (const field of fields) { assert.equal(row[field], null, `${field} must be known NULL, never missing or populated`); delete row[field] }
        assert.deepEqual(rows, before.rows[table], `${table}: exact legacy IDs, bytes and every other field survive all generated rebuilds`)
      }
      const currentIndexes = await indexes()
      for (const old of before.indexes) assert(currentIndexes.some(index => JSON.stringify(index) === JSON.stringify(old)), 'Each exact original audit index survives')
      for (const expected of [
        { columns: ['incident_id', 'handover_key', 'handover_step'], unique: 1 },
        { columns: ['incident_id', 'request_id'], unique: 1 },
        { columns: ['incident_id', 'actor_id', 'handover_assignment_version', 'action', 'sequence'], unique: 0 },
      ]) assert(currentIndexes.some(index => index.unique === expected.unique && JSON.stringify(index.columns) === JSON.stringify(expected.columns)), 'Each new handover index exists with its actual uniqueness')
      assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_list(public_safety_audits)'), before.foreignKeys)
      assert.deepEqual(await database.db.unsafe('PRAGMA foreign_keys'), [{ foreign_keys: 1 }])
      assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
      assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
      await as(before.token, async () => {
        assert.deepEqual(await projection(), before.projection)
        const old = before.rows.public_safety_audits![0]!
        const { id, ...duplicate } = old
        assert(id)
        await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values(duplicate).execute(), /UNIQUE constraint failed/)
        await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values({ ...duplicate, incident_id: 2147483647 }).execute(), /FOREIGN KEY constraint failed/)
        const { registerPublicSafetySource } = await import('../../../resources/functions/drone/public-safety/access/records')
        const { simulatePublicSafety } = await import('../../../resources/functions/drone/public-safety/runtime')
        const registered = await registerPublicSafetySource('upgrade-records', { expectedVersion: 2, recording: simulatePublicSafety({ config: before.config, seconds: 16 }) })
        assert.equal(registered.incident.version, 3)
        assert.equal((await access.readPublicSafetyAudit('upgrade-records')).entries.at(-1)?.action, 'source-registered')
      })
      const snapshot = readFileSync(join(root, snapshotPath), 'utf8'), files = (await readdir(join(root, 'database/migrations'))).sort()
      assert.equal(snapshot, readFileSync(join(source, snapshotPath), 'utf8'))
      for (let pass = 0; pass < 2; pass++) {
        const generated = await database.generateMigrations(); if (generated.isErr) throw generated.error
        assert.equal((await database.pendingMigrationOperations()).length, 0)
        assert.equal(readFileSync(join(root, snapshotPath), 'utf8'), snapshot)
        assert.deepEqual((await readdir(join(root, 'database/migrations'))).sort(), files)
      }
      console.log('PASS current records-through-handover SQL preserves exact historical facts, constraints and two generator no-ops')
    }
  }
  finally { await database.closeDatabaseConnection() }
}
else throw new Error('Unsupported records migration fixture phase')
