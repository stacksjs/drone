import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, renameSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { database, actor, as, seed, managed, root, access, retention, status } from './managed-context'
const mode = process.argv[2]!, stage = process.argv[3]!
const barrier = stage === 'partial-payload' || stage === 'generation-claim' || stage === 'watch-payload' ? 'ownership-committed' : stage === 'pending-manifest' || stage === 'two-aliases' ? 'complete-before-commit' : stage
const rendezvous = join(root, 'managed-process.json'), pause = join(root, 'managed-pause.json')
function tree(target: string) {
  return !existsSync(target) ? [] : readdirSync(target, { recursive: true }).map(name => {
    const stat = lstatSync(join(target, String(name)), { bigint: true })
    return [String(name), String(stat.ino), String(stat.birthtimeNs), String(stat.size), stat.isFile()]
  })
}
try {
  if (mode === 'create') {
    const coordinator = await actor('process-coordinator')
    await as(coordinator.token.plainTextToken, async () => {
      const fixture = await seed('process-lifecycle', 86400000, stage === 'watch-payload' ? 256 : undefined)
      writeFileSync(rendezvous, JSON.stringify({ token: coordinator.token.plainTextToken, key: fixture.config.id, body: fixture.body }))
      if (stage === 'held-prepare' || stage === 'held-publish' || stage === 'generation-claim') {
        const deadline = Date.now() + 60000
        while (!existsSync(join(root, 'contender-ready')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        assert(existsSync(join(root, 'contender-ready')), 'Contender must authenticate before the held write stage')
      }
      let lastAction = '', paused = false
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (sql.startsWith('update public_safety_managed_artifacts') && (stage === 'held-prepare' && event.params?.includes('prepared') || stage === 'held-publish' && event.params?.includes('complete'))) stop()
        if (sql.startsWith('insert into public_safety_managed_artifact_events')) {
          for (const action of ['intent-recorded', 'ownership-recorded', 'published']) if (event.params?.includes(action)) lastAction = action
          if (barrier === 'zero-before-commit' && lastAction === 'ownership-recorded' || barrier === 'complete-before-commit' && lastAction === 'published') stop()
        }
        if (sql.startsWith('select distinct permissions') && (barrier === 'intent-committed' && lastAction === 'intent-recorded' || barrier === 'ownership-committed' && lastAction === 'ownership-recorded')) stop()
      } })
      function stop() {
        if (paused) return
        paused = true
        writeFileSync(pause, JSON.stringify({ stage, pid: process.pid }))
        if (stage === 'held-prepare' || stage === 'held-publish' || stage === 'generation-claim' || stage === 'watch-payload') { process.kill(process.pid, 'SIGSTOP'); return }
        // The independent parent sends a real process signal while native SQL/FS state is held.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000)
        throw new Error('Parent failed to terminate or resume paused fixture')
      }
      try {
        if (stage === 'generation-claim') {
          await assert.rejects(() => managed.createPublicSafetyManagedDataset(fixture.config.id, fixture.body), status(409))
          console.log('PASS paused original live handle refuses committed reconciliation generation'); return
        }
        await managed.createPublicSafetyManagedDataset(fixture.config.id, fixture.body)
        if (stage === 'watch-payload') { console.log('OBSERVATION publication completed before independent partial observer'); return }
        if (stage === 'held-prepare' || stage === 'held-publish') { console.log(`PASS ${stage} completes after competing writer refusal`); return }
        if (stage === 'lost-response') stop()
        assert.fail('Requested process barrier was not reached')
      }
      finally { unhook() }
    })
  }
  else if (mode === 'contend') {
    const saved = JSON.parse(readFileSync(rendezvous, 'utf8'))
    await as(saved.token, async () => {
      // Native Auth legitimately updates last_used_at on first resolution. Resolve it before
      // the writer is stopped so the contender exercises the public reconciliation CAS.
      const { Auth } = await import('@stacksjs/auth/authentication'); assert(await Auth.user())
      writeFileSync(join(root, 'contender-ready'), 'ready')
      const deadline = Date.now() + 60000
      while (!existsSync(pause) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      assert(existsSync(pause))
      const current = (await managed.listPublicSafetyManagedArtifacts(saved.key, { requestId: saved.body.requestId })).entries[0]!
      const command = { expectedVersion: current.incidentVersion, expectedArtifactVersion: current.version, requestId: randomUUID() }
      if (stage === 'generation-claim') {
        const result = await managed.reconcilePublicSafetyManagedArtifact(saved.key, current.key, command)
        assert.equal(result.artifact.state, 'interrupted')
        console.log('PASS real public reconciliation commits new generation between original stages')
      }
      else {
        await assert.rejects(() => managed.reconcilePublicSafetyManagedArtifact(saved.key, current.key, command), error => error instanceof Error && (/locked|busy|SQLITE_BUSY/i.test(error.message) || error instanceof managed.PublicSafetyAccessError && error.status === 409))
        const after = (await managed.listPublicSafetyManagedArtifacts(saved.key)).entries[0]!
        assert.deepEqual(after, current, 'competing public writer cannot claim while original native CAS owns SQLite write authority')
        console.log(`PASS real public reconciler cannot write during ${stage} write authority`)
      }
    })
  }
  else {
    const saved = JSON.parse(readFileSync(rendezvous, 'utf8'))
    await as(saved.token, async () => {
      const lookup = await managed.listPublicSafetyManagedArtifacts(saved.key, { requestId: saved.body.requestId })
      assert.equal(lookup.entries.length, 1)
      const before = lookup.entries[0]!
      const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
      const row = writer.query('SELECT target_path, receipt_json FROM public_safety_managed_artifacts WHERE artifact_key=?').get(before.key) as { target_path: string, receipt_json: string | null }
      writer.close()
      // These controlled mutations qualify read-only interpretation of exact registered inodes.
      // They are explicitly not evidence of observing these narrow windows during a real kill.
      if (stage === 'partial-payload') writeFileSync(join(row.target_path, 'recording.json'), 'controlled partial payload')
      if (stage === 'pending-manifest') renameSync(join(row.target_path, 'manifest.json'), join(row.target_path, 'manifest.pending.json'))
      if (stage === 'two-aliases') linkSync(join(row.target_path, 'manifest.json'), join(row.target_path, 'manifest.pending.json'))
      const originalTree = tree(row.target_path)
      if (stage === 'intent-committed') { assert.equal(before.state, 'intent'); assert.equal(originalTree.length, 0); assert.equal(row.receipt_json, null) }
      if (stage === 'zero-before-commit') { assert.equal(before.state, 'intent'); assert.equal(row.receipt_json, null); assert(originalTree.length > 0); assert(originalTree.filter(item => item[4]).every(item => item[3] === '0')) }
      if (stage === 'ownership-committed') { assert.equal(before.state, 'prepared'); assert(row.receipt_json); assert(originalTree.filter(item => item[4]).every(item => item[3] === '0')) }
      if (stage === 'complete-before-commit') { assert.equal(before.state, 'prepared'); assert(existsSync(join(row.target_path, 'manifest.json'))) }
      if (stage === 'lost-response') assert.equal(before.state, 'complete')
      const replay = await managed.createPublicSafetyManagedDataset(saved.key, saved.body)
      assert.equal(replay.replayed, true); assert.equal(replay.artifact.state, before.state)
      assert.deepEqual(tree(row.target_path), originalTree, 'fresh-process replay cannot restore the lost live writer')
      const result = await managed.reconcilePublicSafetyManagedArtifact(saved.key, before.key, { expectedVersion: before.incidentVersion, expectedArtifactVersion: before.version, requestId: randomUUID() })
      assert.equal(result.artifact.state, stage === 'zero-before-commit' ? 'blocked' : stage === 'complete-before-commit' || stage === 'lost-response' || stage === 'two-aliases' ? 'complete' : 'interrupted')
      assert.deepEqual(tree(row.target_path), originalTree, 'fresh-process classification never writes or deletes physical evidence')
      const observations = await database.db.primary.selectFrom('public_safety_managed_artifact_files').select(['role', 'planned_bytes', 'sha256', 'observed_bytes', 'observed_sha256']).where('artifact_id', '=', (await database.db.primary.selectFrom('public_safety_managed_artifacts').select('id').where('artifact_key', '=', before.key).executeTakeFirst())!.id).execute()
      if (stage === 'zero-before-commit') assert(observations.every(file => file.observed_bytes === null && file.observed_sha256 === null), 'unknown zero tree is never adopted into an ownership ledger')
      if (stage === 'ownership-committed') assert(observations.every(file => file.observed_bytes === 0 && file.observed_sha256 !== file.sha256), 'empty actual observations remain separate from planned bytes')
      if (stage === 'partial-payload') {
        const partial = observations.find(file => file.role === 'recording')!
        assert.equal(partial.observed_bytes, 26)
        assert(partial.planned_bytes > 26 && partial.observed_sha256 !== partial.sha256)
      }

      assert.equal((await access.readPublicSafetyIncident(saved.key)).version, before.incidentVersion + 2)
      assert.equal((await retention.readPublicSafetyRetention(saved.key)).version, 1)
      console.log(`PASS ${barrier === stage || stage === 'watch-payload' ? 'real child kill' : 'controlled registered-inode fixture'} ${stage}, fresh discovery, immutable replay and read-only reconciliation`)
    })
  }
}
finally { await database.closeDatabaseConnection() }
