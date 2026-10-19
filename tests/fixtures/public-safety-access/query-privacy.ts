import assert from 'node:assert/strict'
import { cp, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'

// Real native query hooks and their persisted/file diagnostics, with the actual app config.
// This disposable database is not the app database and contains no real incident material.
const source = resolve(import.meta.dir, '../../..')
const { root, database, User } = await setupIncidentDatabase({
  prepare: root => cp(join(source, 'config/database.ts'), join(root, 'config/database.ts')),
})
const { config } = await import('@stacksjs/config')
const { log } = await import('@stacksjs/logging')
const { persistQueryLogValues } = await import('@stacksjs/database/query-log-bindings')
assert.equal(config.database.queryLogging?.enabled, true)
assert.equal(config.database.queryLogging?.captureBindings, true)
const db = database.db
const now = new Date().toISOString()
try {
  const user = await User.create({ name: 'Diagnostic fixture', email: 'diagnostic@example.invalid', password: 'temporary-fixture-password' })
  await db.insertInto('public_safety_incidents').values({ incident_key: 'diagnostic-fixture', version: 1, coordinator_id: user.id, status: 'active', purpose: 'search-and-rescue', revision: 'revision-1', config_json: '{}', retain_until: new Date(Date.now() + 86400000).toISOString(), created_at: now, updated_at: now }).execute()
  const incident = await db.primary.selectFrom('public_safety_incidents').select('id').where('incident_key', '=', 'diagnostic-fixture').executeTakeFirst()
  assert(incident)
  await db.insertInto('public_safety_sources').values({ incident_id: incident.id, digest: 'a'.repeat(64), byte_length: 2, canonical_json: '{}', replay_profile: 'owned-public-safety-collection-v1', evidence: 'owned-public-safety-physics-simulation', uploader_id: user.id, uploaded_at_iso: now, created_sequence: 2, created_at: now, updated_at: now }).execute()
  const sourceRow = await db.primary.selectFrom('public_safety_sources').select('id').where('incident_id', '=', incident.id).executeTakeFirst()
  assert(sourceRow)
  await db.insertInto('public_safety_observations').values({ source_id: sourceRow.id, capture_id: 'photo-0001', modality: 'visible', pixel_x: 0, pixel_y: 0, note: 'bootstrap', uncertainty_note: 'bootstrap', actor_id: user.id, observed_at_iso: now, created_sequence: 3, created_at: now, updated_at: now }).execute()
  const observation = await db.primary.selectFrom('public_safety_observations').select('id').where('source_id', '=', sourceRow.id).executeTakeFirst()
  assert(observation)
  await db.insertInto('public_safety_reviews').values({ observation_id: observation.id, previous_review_id: null, disposition: 'unresolved', note: 'bootstrap', actor_id: user.id, reviewed_at_iso: now, created_sequence: 4, created_at: now, updated_at: now }).execute()
  const review = await db.primary.selectFrom('public_safety_reviews').select('id').where('observation_id', '=', observation.id).executeTakeFirst()
  assert(review)
  await db.insertInto('public_safety_audits').values({ incident_id: incident.id, sequence: 1, actor_id: user.id, action: 'created', target_user_id: null, at_iso: now, details_json: '{}', created_at: now, updated_at: now }).execute()
  const audit = await db.primary.selectFrom('public_safety_audits').select('id').where('incident_id', '=', incident.id).executeTakeFirst()
  assert(audit)
  const canaries: string[] = []
  for (const field of ['details_json', 'handover_key', 'handover_step', 'handover_assignment_version', 'request_id', 'request_digest']) {
    const canary = `Private diagnostic handover ${field} ordinary fixture words`
    canaries.push(canary)
    const fallback = persistQueryLogValues(`UPDATE public_safety_audits SET ${field} = ? WHERE id = ?`, [canary, 1], `Driver reflected ${canary}`, { captureValues: true, sensitiveColumns: config.database.queryLogging?.sensitiveColumns })
    assert.deepEqual(JSON.parse(fallback.bindings), ['<redacted>', 1], `handover fallback must redact ${field} independently of normal private-query exclusion`)
    assert(!fallback.error?.includes(canary), `handover reflected fallback must redact ${field}`)
  }
  const targets = [
    ['public_safety_incidents', 'config_json', incident.id],
    ['public_safety_sources', 'canonical_json', sourceRow.id],
    ['public_safety_observations', 'note', observation.id],
    ['public_safety_observations', 'uncertainty_note', observation.id],
    ['public_safety_reviews', 'note', review.id],
    ['public_safety_audits', 'details_json', audit.id],
  ] as const
  for (const [index, [table, field, id]] of targets.entries()) {
    const successful = `Private diagnostic success surface ${index} fixture words`
    const failed = `Private diagnostic failure surface ${index} fixture words`
    canaries.push(successful, failed)
    // Also exercise the explicit qualified-column fallback against the native SQL/value scanner.
    const fallback = persistQueryLogValues(`UPDATE ${table} SET ${field} = ? WHERE id = ?`, [failed, id], `Driver reflected ${failed}`, { captureValues: true, sensitiveColumns: config.database.queryLogging?.sensitiveColumns })
    assert.deepEqual(JSON.parse(fallback.bindings), ['<redacted>', id])
    assert(!fallback.error?.includes(failed))
    // The real SQLite driver reflects the failed bound value in its error.
    // The trigger is solely a fixture fault and is confined to this generated private schema.
    await db.unsafe(`CREATE TRIGGER diagnostic_failure_${index} BEFORE UPDATE OF ${field} ON ${table} WHEN NEW.${field} = '${failed}' BEGIN SELECT RAISE(ABORT, '${failed}'); END`).execute()
    await db.updateTable(table).set({ [field]: successful }).where('id', '=', id).execute()
    await assert.rejects(() => db.updateTable(table.toUpperCase()).set({ [field]: failed }).where('id', '=', id).execute(), error => error instanceof Error && error.message.includes(failed))
    const row = await db.primary.selectFrom(table).select(field).where('id', '=', id).executeTakeFirst()
    assert.equal(row?.[field], successful)
  }
  await db.unsafe('CREATE TABLE diagnostic_public_probe (id INTEGER PRIMARY KEY, caption TEXT NOT NULL)').execute()
  const publicSuccess = 'Public diagnostic success fixture words', publicFailure = 'Public diagnostic failure fixture words'
  await db.insertInto('diagnostic_public_probe').values({ id: 1, caption: publicSuccess }).execute()
  await assert.rejects(() => db.insertInto('diagnostic_public_probe').values({ id: 1, caption: publicFailure }).execute())
  // A later real query is the persistence barrier for earlier native hook events.
  const barrier = 'Public diagnostic final barrier fixture words'
  await db.updateTable('diagnostic_public_probe').set({ caption: barrier }).where('id', '=', 1).execute()
  let rows: Record<string, unknown>[] = []
  const deadline = Date.now() + 10000
  do {
    rows = await db.primary.selectFrom('query_logs').selectAll().execute() as Record<string, unknown>[]
    if (rows.some(row => String(row.bindings).includes(barrier))) break
    await Bun.sleep(10)
  } while (Date.now() < deadline)
  assert(rows.some(row => String(row.bindings).includes(barrier)), 'native public diagnostic barrier was not persisted')
  assert(rows.some(row => row.status === 'completed' && String(row.bindings).includes(publicSuccess)), 'public success diagnostics must retain enabled bound values')
  assert(rows.some(row => row.status === 'failed' && String(row.bindings).includes(publicFailure)), 'public failed diagnostics must still work')
  assert(!rows.some(row => String(row.query).toLowerCase().includes('public_safety_')), 'private SQL must never create query history rows')
  const diagnostics = JSON.stringify(rows)
  for (const canary of canaries) assert(!diagnostics.includes(canary), 'private material copied into query diagnostics')
  await log.flush()
  async function localLogs(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const texts: string[] = []
    for (const entry of entries) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) texts.push(...await localLogs(file))
      else if (entry.isFile()) texts.push(await readFile(file, 'utf8'))
    }
    return texts
  }
  const files = (await localLogs(join(root, 'storage/logs'))).join('\n')
  assert(files.includes('diagnostic_public_probe'), 'public failed-query diagnostics must reach the local file transport')
  for (const canary of canaries) assert(!files.includes(canary), 'private failed-query material copied into local logs')
  console.log('PASS native private query diagnostics excluded while public bound diagnostics persist')
}
finally { await log.flush(); await database.closeDatabaseConnection() }
