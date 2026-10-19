import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
try {
  const seeded = await f.seed('workspace-bundled-scope')
  const policy = fileURLToPath(new URL('../../../resources/functions/drone/public-safety/workspace/policy.ts', import.meta.url))
  const incidentPolicy = fileURLToPath(new URL('../../../resources/functions/drone/public-safety/access/policy.ts', import.meta.url))
  const entries = join(process.cwd(), 'app/ScopeProbe')
  await mkdir(entries, { recursive: true })
  // Installed native Gate state is module-local. Boot the genuine view policy
  // in each probe copy to isolate the workspace incarnation behavior. This does
  // not qualify application-wide authorization bootstrap across server bundles.
  for (const name of ['First', 'Second']) await writeFile(join(entries, `${name}.ts`), `import { Gate } from '@stacksjs/auth/gate'\nimport { publicSafetyIncidentGate } from ${JSON.stringify(incidentPolicy)}\nGate.define('public-safety:view', (user, key) => publicSafetyIncidentGate(user, key, 'view'))\nexport { readWorkspaceAccess as read } from ${JSON.stringify(policy)}\n`)
  // The native app builder emits each app entry independently with splitting off.
  // This tests real authorization through those copies, not a replica of the scope hash.
  const built = await Bun.build({
    root: join(process.cwd(), 'app'),
    entrypoints: ['First', 'Second'].map(name => join(entries, `${name}.ts`)),
    outdir: join(process.cwd(), 'scope-artifact/app'),
    format: 'esm',
    target: 'bun',
    splitting: false,
    external: ['@swc/wasm'],
  })
  assert(built.success, built.logs.map(String).join('\n'))
  const source = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const first = await import(join(process.cwd(), 'scope-artifact/app/ScopeProbe/First.js')) as { read: typeof source.readWorkspaceAccess }
  const second = await import(join(process.cwd(), 'scope-artifact/app/ScopeProbe/Second.js')) as { read: typeof source.readWorkspaceAccess }
  const initial = await f.as(f.senderToken, () => source.readWorkspaceAccess(seeded.key))
  const one = await f.as(f.senderToken, () => first.read(seeded.key))
  assert.equal(one.scope, initial.scope, 'A separately bundled workspace reader retains the same process incarnation')
  const two = await f.as(f.senderToken, () => second.read(seeded.key, initial.scope))
  assert.equal(two.scope, initial.scope, 'Another separately bundled reader accepts the original authorized scope')
  assert.equal(one.accountId, f.sender.id)
  assert.equal(two.incidentId, initial.incidentId)
  console.log('PASS native workspace scope across independently bundled application entries')
}
finally { await f.database.closeDatabaseConnection() }
