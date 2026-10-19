import assert from 'node:assert/strict'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupExecutionBootstrap } from './execution-bootstrap-setup'

const h = await setupExecutionBootstrap('bundles')
try {
  const source = resolve(import.meta.dir, '../../..')
  const entries = join(process.cwd(), 'app/ExecutionBootstrap')
  await mkdir(entries, { recursive: true })
  for (const name of ['First', 'Second']) await writeFile(join(entries, `${name}.ts`), `import { Gate } from '@stacksjs/auth/gate'
import { publicSafetyIncidentGate } from ${JSON.stringify(join(source, 'resources/functions/drone/public-safety/access/policy.ts'))}
Gate.define('public-safety:view', (user, key) => publicSafetyIncidentGate(user, key, 'view'))
export { executionOwner } from ${JSON.stringify(join(source, 'resources/functions/drone/public-safety/execution/state.ts'))}
export { readWorkspaceAccess } from ${JSON.stringify(join(source, 'resources/functions/drone/public-safety/workspace/policy.ts'))}
`)
  const outdir = join(process.cwd(), 'execution-bootstrap-build/app')
  const copied = join(process.cwd(), 'execution-bootstrap-copied/app')
  const built = await Bun.build({ root: join(process.cwd(), 'app'), entrypoints: ['First', 'Second'].map(name => join(entries, `${name}.ts`)), outdir, target: 'bun', format: 'esm', splitting: false, external: ['@swc/wasm'] })
  assert(built.success, built.logs.map(String).join('\n'))
  await cp(outdir, copied, { recursive: true })
  type Copy = { executionOwner: typeof h.executionOwner, readWorkspaceAccess: typeof h.readWorkspaceAccess }
  const first = await import(join(copied, 'ExecutionBootstrap/First.js')) as Copy
  const second = await import(join(copied, 'ExecutionBootstrap/Second.js')) as Copy
  assert.equal(first.executionOwner(), h.executionOwner())
  assert.equal(second.executionOwner(), h.executionOwner())
  const started = await h.start()
  for (const copy of [first, second]) {
    assert.equal(copy.executionOwner().slot, started.slot, 'Independent copies see the actual production reservation, never a placeholder')
    const access = await h.f.as(h.f.senderToken, () => copy.readWorkspaceAccess(h.key, h.scope))
    assert.equal(access.scope, h.scope)
    assert.equal(access.accountId, h.f.sender.id)
  }
  const result = await h.complete()
  assert.equal(first.executionOwner().slot, started.slot)
  assert.equal(second.executionOwner().slot, started.slot)
  // Genuine view policy is explicitly installed per copy because installed native
  // Gate registries differ. This isolates process owner/scope sharing; it does not
  // qualify authenticated bundled-server authorization boot or registry routing.
  console.log(JSON.stringify({ oracle: 'production-bootstrap-bundles', actualReservationShared: true, actualScopeShared: true, independentCopies: 2, ...result, fullAuthenticatedBundledServerQualified: false }))
  console.log('PASS native independently bundled production owner and scope')
}
finally { await h.close() }
