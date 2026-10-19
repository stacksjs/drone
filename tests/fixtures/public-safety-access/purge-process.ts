import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { actor, as, seed, database, root, managed } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const mode = process.argv[2], stage = process.argv[3] ?? 'unlink-before-result-commit'
const savedPath = join(root, 'purge-process.json'), pausePath = join(root, 'purge-process-paused.json')
function names(directory: string) { return existsSync(directory) ? readdirSync(directory, { recursive: true }).map(name => { const path = join(directory, String(name)), stat = lstatSync(path, { bigint: true }); return [String(name), String(stat.ino), String(stat.birthtimeNs), String(stat.size)] }) : [] }
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  if (mode === 'create') {
    const coordinator = await actor('purge-process-coordinator')
    await as(coordinator.token.plainTextToken, async () => {
      const fixture = await seed('purge-process', 10000)
      const created = await managed.createPublicSafetyManagedDataset('purge-process', fixture.body)
      const directory = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key)
      const sibling = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, 'excluded-process-sibling.txt'); writeFileSync(sibling, 'excluded-sibling-fragment', { mode: 0o600 })
      const wait = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 20
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      const preview = await purge.previewPublicSafetyPurge('purge-process')
      const accepted = await purge.acceptPublicSafetyPurge('purge-process', { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      writeFileSync(savedPath, JSON.stringify({ key: 'purge-process', purgeKey: accepted.purge.purgeKey, token: coordinator.token.plainTextToken, directory, sibling, initial: names(directory) }))
      let paused = false
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (paused || !sql.startsWith('insert into public_safety_purge_events') || !event.params?.includes('result')) return
        const delta = event.params.find(value => typeof value === 'string' && value.includes('"namesUnlinked":'))
        if (typeof delta !== 'string' || JSON.parse(delta).namesUnlinked < 1) return
        paused = true
        writeFileSync(pausePath, JSON.stringify({ stage, pid: process.pid, after: names(directory), delta: JSON.parse(delta) }))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000)
        throw new Error('Parent did not terminate the actual uncommitted result window')
      } })
      try {
        let current = accepted.purge
        for (let count = 0; count < 60; count++) {
          await job.dispatchNow({ purgeKey: current.purgeKey })
          current = await purge.readPublicSafetyPurge('purge-process', current.purgeKey)
          assert.notEqual(current.state, 'blocked', `Actual native inspection/effect is unavailable: ${current.outcomeCode}`)
          assert.notEqual(current.state, 'complete', 'Actual unlink/result barrier must be observed before completion')
        }
        assert.fail('Actual result barrier was not observed')
      }
      finally { unhook() }
    })
  }
  else if (mode === 'recover') {
    const saved = JSON.parse(readFileSync(savedPath, 'utf8')), paused = JSON.parse(readFileSync(pausePath, 'utf8'))
    assert.equal(stage, 'unlink-before-result-commit'); assert.equal(paused.delta.namesUnlinked, 1)
    assert(paused.after.length < saved.initial.length, 'Actual namespace effect preceded process termination')
    await as(saved.token, async () => {
      let current = await purge.readPublicSafetyPurge(saved.key, saved.purgeKey)
      assert.equal(current.completed.namesUnlinked, 0, 'Uncommitted unlink acknowledgment rolled back')
      const armed = await database.db.primary.selectFrom('public_safety_purge_items').select(['state', 'arm_json']).where('state', '=', 'armed').execute()
      assert.equal(armed.length, 1); assert(armed[0]!.arm_json)
      for (let count = 0; count < 100 && current.state !== 'complete'; count++) {
        await job.dispatchNow({ purgeKey: current.purgeKey })
        current = await purge.readPublicSafetyPurge(saved.key, current.purgeKey)
        assert.notEqual(current.state, 'blocked', `Fresh process recovery blocked: ${current.outcomeCode}`)
      }
      assert.equal(current.state, 'complete'); assert.equal(existsSync(saved.directory), false)
      assert.equal(current.completed.namesAbsenceReconciled, 1, 'Lost acknowledgment uses separate durable absence reconciliation')
      assert.equal(current.completed.namesInitiallyAbsent, 1)
      assert.equal(current.completed.namesVerifiedAbsent, current.completed.namesUnlinked + current.completed.namesInitiallyAbsent + current.completed.namesAbsenceReconciled)
      assert.equal(readFileSync(saved.sibling, 'utf8'), 'excluded-sibling-fragment')
      assert.equal((await database.db.primary.selectFrom('public_safety_purge_items').select('id').execute()).length, 0)
      console.log('PASS genuine SIGKILL after unlink before result COMMIT recovers exact armed absence with disjoint counters')
    })
  }
  else throw new Error('Unknown guarded purge process fixture mode')
}
finally { await database.closeDatabaseConnection() }
