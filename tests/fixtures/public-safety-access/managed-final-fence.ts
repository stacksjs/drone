import assert from 'node:assert/strict'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { actor, as, seed, database, managed, status } from './managed-context'
const coordinator = await actor('managed-final-fence-coordinator')
try {
  await as(coordinator.token.plainTextToken, async () => {
    for (const phase of ['prepared', 'complete'] as const) for (const fault of ['nonce', 'generation', 'state'] as const) {
      const key = `b-final-${phase[0]}-${fault[0]}`, fixture = await seed(key)
      const assignment = { nonce: "operation_nonce = '00000000-0000-4000-8000-000000000000'", generation: 'generation = generation + 1', state: "state = 'blocked'" }[fault]
      await database.db.primary.unsafe(`CREATE TRIGGER controlled_managed_final_fence AFTER UPDATE OF operation_nonce ON public_safety_managed_artifacts WHEN OLD.state = '${phase}' AND NEW.state = '${phase}' AND OLD.version = NEW.version BEGIN UPDATE public_safety_managed_artifacts SET ${assignment} WHERE id = NEW.id; END`).execute()
      await assert.rejects(() => managed.createPublicSafetyManagedDataset(key, fixture.body), status(409))
      const row = (await managed.listPublicSafetyManagedArtifacts(key)).entries[0]!
      const directory = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, row.key)
      if (phase === 'prepared') { assert.equal(row.state, 'intent'); assert.equal(existsSync(directory), false) }
      else {
        assert.equal(row.state, 'prepared'); assert.equal(existsSync(join(directory, 'manifest.json')), false)
        for (const name of readdirSync(directory, { recursive: true })) { const stat = lstatSync(join(directory, String(name))); if (stat.isFile()) assert.equal(stat.size, 0) }
      }
      await database.db.primary.unsafe('DROP TRIGGER controlled_managed_final_fence').execute()
      console.log(`PASS actual B final nonce UPDATE AFTER trigger ${phase} ${fault} refuses subsequent filesystem effects`)
    }
  })
}
finally { await database.closeDatabaseConnection() }
