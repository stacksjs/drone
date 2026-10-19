import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { actor, as, seed, database, managed, status } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const method = process.argv[2]
assert(method === 'close' || method === 'reset')
const observer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
function tree(directory: string) { return readdirSync(directory, { recursive: true }).map(name => { const stat = lstatSync(join(directory, String(name)), { bigint: true }); return [String(name), String(stat.ino), String(stat.birthtimeNs), String(stat.size)] }) }
try {
  const coordinator = await actor(`purge-retirement-${method}`)
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(coordinator.token.plainTextToken, async () => {
    const key = `p-retire-${method}`, fixture = await seed(key, 10000), created = await managed.createPublicSafetyManagedDataset(key, fixture.body)
    const directory = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key), before = tree(directory), bytes = readFileSync(join(directory, 'recording.json'))
    const wait = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    const preview = await purge.previewPublicSafetyPurge(key), accepted = await purge.acceptPublicSafetyPurge(key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
    let armCommitted = false, fired = 0, closing: Promise<void> | undefined
    const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
      const sql = event.sql.replace(/["`]/g, '').toLowerCase()
      if (sql.startsWith('insert into public_safety_purge_events') && event.params?.includes('arm')) armCommitted = true
      if (fired || !armCommitted || !sql.startsWith('update public_safety_purge_items')) return
      fired++
      queueMicrotask(() => { if (method === 'close') closing = database.closeDatabaseConnection(); else database.resetDatabaseConnection() })
    } })
    try {
      for (let n = 0; n < 30 && !fired; n++) {
        try { await job.dispatchNow({ purgeKey: accepted.purge.purgeKey }) }
        catch (error) { assert(status(409)(error)); if (!fired) throw error }
      }
    }
    finally { unhook(); await closing }
    assert.equal(fired, 1, 'Retirement must happen after real arm COMMIT and awaited item claim')
    assert.deepEqual(tree(directory), before); assert.deepEqual(readFileSync(join(directory, 'recording.json')), bytes)
    const row = observer.query('SELECT id, progress_counts_json FROM public_safety_purges WHERE purge_key=?').get(accepted.purge.purgeKey) as { id: number, progress_counts_json: string }
    const progress = JSON.parse(row.progress_counts_json)
    assert.equal(progress.namesUnlinked, 0); assert.equal(progress.fileInodesVerifiedAbsent, 0)
    const items = observer.query("SELECT state, arm_json FROM public_safety_purge_items WHERE purge_id=? AND state='armed'").all(row.id)
    assert.equal(items.length, 1)
    console.log(`PASS actual C native ${method} after arm COMMIT refuses late captured filesystem execution at terminal process boundary`)
  })
}
finally { observer.close(); await database.closeDatabaseConnection() }
