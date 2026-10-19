import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
const { database, User } = await setupIncidentDatabase()
const { createPublicSafetyIncident, readPublicSafetyIncident, changePublicSafetyMembership, readPublicSafetyAudit, closePublicSafetyIncident } = await import('../../../resources/functions/drone/public-safety/access/service')
const { publicSafetyIncidentGate, publicSafetyCreateGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { PublicSafetyAccessError } = await import('../../../resources/functions/drone/public-safety/access/errors')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken, revokeToken } = await import('@stacksjs/auth/tokens')
const { Auth } = await import('@stacksjs/auth/authentication')
const { createBqbRbacStore } = await import('@stacksjs/auth/rbac-store-bqb')
const { transaction } = await import('@stacksjs/orm')
const { sqlDateTime } = await import('@stacksjs/database/runtime')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
// The native enhancer mutates a Request; its declaration requires the resulting enriched type.
const nativeRequest = (init: RequestInit) => enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', init) as Parameters<typeof enhanceRequest>[0])
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of ['view', 'audit', 'manage-members', 'close'] as const) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
try {
  if (process.env.INCIDENT_DURABILITY_READ === '1') {
    const saved = JSON.parse(await readFile(join(process.cwd(), 'durability.json'), 'utf8'))
    await runWithRequest(nativeRequest({ headers: { authorization: `Bearer ${saved.token}` } }), async () => {
      const incident = await readPublicSafetyIncident(saved.key)
      assert.equal(incident.status, 'closed')
      assert.equal(incident.version, 3)
      assert.deepEqual((await readPublicSafetyAudit(saved.key)).entries.map(entry => entry.action), ['created', 'member-granted', 'closed'])
    })
    console.log('PASS incident survives a fresh process')
  }
  else {
  const coordinator = await User.create({ name: 'Incident Coordinator', email: 'coordinator@example.invalid', password: 'temporary-fixture-password' })
  const observer = await User.create({ name: 'Incident Observer', email: 'observer@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:access', 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:create', 'web')
  await Rbac.givePermission(observer.id, 'public-safety:access', 'web')
  const token = await createToken(coordinator.id, 'fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
  const other = await createToken(observer.id, 'fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
  const as = <T>(credential: string | null, action: () => Promise<T>) => runWithRequest(nativeRequest({ headers: credential ? { authorization: `Bearer ${credential}` } : {} }), action)
  const status = (code: number) => (error: unknown) => error instanceof PublicSafetyAccessError && error.status === code
  const config = examplePublicSafetyConfig()
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await assert.rejects(() => as(null, () => createPublicSafetyIncident({ config })), status(401))
  const created = await as(token.plainTextToken, () => createPublicSafetyIncident({ config }))
  assert.equal(created.key, config.id)
  assert.equal(created.version, 1)
  assert.equal(created.membership.role, 'coordinator')
  assert.equal(created.identityAuthenticated, true)
  const read = await as(token.plainTextToken, () => readPublicSafetyIncident(config.id))
  assert.deepEqual(read.config, config)
  await assert.rejects(() => as(other.plainTextToken, () => readPublicSafetyIncident(config.id)), status(403))
  const granted = await as(token.plainTextToken, () => changePublicSafetyMembership(config.id, { expectedVersion: 1, userId: observer.id, role: 'observer' }))
  assert.equal(granted.incident.version, 2)
  assert.equal(granted.membership.role, 'observer')
  const observerRead = await as(other.plainTextToken, () => readPublicSafetyIncident(config.id))
  assert.equal(observerRead.membership.role, 'observer')
  await assert.rejects(() => as(other.plainTextToken, () => readPublicSafetyAudit(config.id)), status(403))
  const audit = await as(token.plainTextToken, () => readPublicSafetyAudit(config.id))
  assert.deepEqual(audit.entries.map(row => [row.sequence, row.actorId, row.action, row.targetUserId]), [[1, coordinator.id, 'created', null], [2, coordinator.id, 'member-granted', observer.id]])
  const page = await as(token.plainTextToken, () => readPublicSafetyAudit(config.id, { limit: 1 }))
  assert.deepEqual([page.entries.length, page.cursor, page.hasMore], [1, 1, true])
  const next = await as(token.plainTextToken, () => readPublicSafetyAudit(config.id, { afterSequence: page.cursor, limit: 1 }))
  assert.deepEqual([next.entries[0]?.sequence, next.cursor, next.hasMore], [2, 2, false])
  await assert.rejects(() => as(token.plainTextToken, () => changePublicSafetyMembership(config.id, { expectedVersion: 1, userId: observer.id, role: null })), status(409))
  await assert.rejects(() => as(other.plainTextToken, () => closePublicSafetyIncident(config.id, { expectedVersion: 2 })), status(403))
  const closed = await as(token.plainTextToken, () => closePublicSafetyIncident(config.id, { expectedVersion: 2 }))
  assert.equal(closed.version, 3)
  assert.equal(closed.status, 'closed')
  assert.equal((await as(other.plainTextToken, () => readPublicSafetyIncident(config.id))).status, 'closed')
  await assert.rejects(() => as(token.plainTextToken, () => changePublicSafetyMembership(config.id, { expectedVersion: 3, userId: observer.id, role: null })), status(409))

  // The established seam is the exported service, using actual native auth, gates and file-backed SQL.
  // Fixture writes below create credential/fault states. Assertions read outcomes through this seam.
  const configFor = (id: string) => ({ ...config, id })
  const make = async (id: string) => as(token.plainTextToken, () => createPublicSafetyIncident({ config: configFor(id) }))
  const change = (key: string, version: number, role: 'pilot' | 'observer' | 'reviewer' | 'evidence-custodian' | null = 'observer') => as(token.plainTextToken, () => changePublicSafetyMembership(key, { expectedVersion: version, userId: observer.id, role }))
  const readMain = (key: string) => as(token.plainTextToken, () => readPublicSafetyIncident(key))
  const auditMain = (key: string) => as(token.plainTextToken, () => readPublicSafetyAudit(key))
  const missingScope = await createToken(coordinator.id, 'no incident scope', [], { withRefreshToken: false })
  const readScope = await createToken(coordinator.id, 'read only', ['public-safety:read'], { withRefreshToken: false })
  const coordinateScope = await createToken(coordinator.id, 'coordinate only', ['public-safety:coordinate'], { withRefreshToken: false })
  await assert.rejects(() => as('invalid-credential', () => readPublicSafetyIncident(config.id)), status(401))
  await assert.rejects(() => as(missingScope.plainTextToken, () => readPublicSafetyIncident(config.id)), status(403))
  await assert.rejects(() => as(coordinateScope.plainTextToken, () => readPublicSafetyIncident(config.id)), status(403))
  await assert.rejects(() => as(readScope.plainTextToken, () => createPublicSafetyIncident({ config: configFor('read-only-create') })), status(403))
  await assert.rejects(() => as(other.plainTextToken, () => createPublicSafetyIncident({ config: configFor('missing-create-permission') })), status(403))
  await Rbac.createPermission('public-safety:access', 'api')
  await Rbac.givePermission(observer.id, 'public-safety:access', 'api')
  await Rbac.revokePermission(observer.id, 'public-safety:access', 'web')
  await assert.rejects(() => as(other.plainTextToken, () => readPublicSafetyIncident(config.id)), status(403))
  await Rbac.givePermission(observer.id, 'public-safety:access', 'web')

  for (const state of ['revoked', 'expired', 'subject-mismatch', 'password-changed'] as const) {
    const credential = await createToken(coordinator.id, state, ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
    await as(credential.plainTextToken, async () => {
      assert.equal(await Auth.tokenCan('public-safety:read'), true)
      assert.equal((await Auth.user())?.id, coordinator.id)
      if (state === 'revoked') await revokeToken(credential.plainTextToken)
      if (state === 'expired') await database.db.primary.updateTable('oauth_access_tokens').set({ expires_at: sqlDateTime(new Date(Date.now() - 1)) }).where('id', '=', credential.accessToken.id).execute()
      if (state === 'subject-mismatch') await database.db.primary.updateTable('oauth_access_tokens').set({ user_id: observer.id }).where('id', '=', credential.accessToken.id).execute()
      if (state === 'password-changed') await database.db.primary.updateTable('users').set({ password_changed_at: sqlDateTime(new Date(Date.now() + 1000)) }).where('id', '=', coordinator.id).execute()
      await assert.rejects(() => readPublicSafetyIncident(config.id), status(401))
      if (state === 'password-changed') await database.db.primary.updateTable('users').set({ password_changed_at: null }).where('id', '=', coordinator.id).execute()
    })
  }
  const key = 'native-policy-matrix'
  await make(key)
  for (const role of ['pilot', 'observer', 'reviewer', 'evidence-custodian'] as const) {
    const current = await readMain(key)
    await change(key, current.version, role)
    await as(other.plainTextToken, async () => {
      assert.equal((await readPublicSafetyIncident(key)).membership.role, role)
      if (role === 'evidence-custodian') assert((await readPublicSafetyAudit(key)).entries.length > 0)
      else await assert.rejects(() => readPublicSafetyAudit(key), status(403))
      await assert.rejects(() => changePublicSafetyMembership(key, { expectedVersion: current.version + 1, userId: coordinator.id, role: 'observer' }), status(403))
      await assert.rejects(() => closePublicSafetyIncident(key, { expectedVersion: current.version + 1 }), status(403))
    })
  }
  const beforeRevoke = await readMain(key)
  await change(key, beforeRevoke.version, null)
  await assert.rejects(() => as(other.plainTextToken, () => readPublicSafetyIncident(key)), status(403))
  await assert.rejects(() => as(other.plainTextToken, () => readPublicSafetyAudit(key)), status(403))
  await assert.rejects(() => change(key, beforeRevoke.version + 1, null), status(409))
  await assert.rejects(() => as(token.plainTextToken, () => changePublicSafetyMembership(key, { expectedVersion: beforeRevoke.version + 1, userId: coordinator.id, role: null })), status(409))
  await assert.rejects(() => as(token.plainTextToken, () => changePublicSafetyMembership(key, { expectedVersion: beforeRevoke.version + 1, userId: observer.id, role: 'coordinator' })), status(422))
  await assert.rejects(() => as(token.plainTextToken, () => changePublicSafetyMembership(key, { expectedVersion: beforeRevoke.version + 1, userId: 2147483647, role: 'observer' })), status(422))
  await assert.rejects(() => make(key), status(409))
  for (const invalid of [0, -1, 1.5, NaN, '1', 2147483647]) await assert.rejects(() => as(token.plainTextToken, () => closePublicSafetyIncident(key, { expectedVersion: invalid })), status(422))
  for (const invalid of [{ config: configFor('forged-create'), actorId: observer.id }, { config: configFor('forged-create'), userId: observer.id }]) await assert.rejects(() => as(token.plainTextToken, () => createPublicSafetyIncident(invalid)), status(422))
  await assert.rejects(() => as(token.plainTextToken, () => changePublicSafetyMembership(key, { expectedVersion: beforeRevoke.version + 1, userId: observer.id, role: 'observer', actorId: observer.id })), status(422))
  await assert.rejects(() => as(token.plainTextToken, () => closePublicSafetyIncident(key, { expectedVersion: beforeRevoke.version + 1, actorId: observer.id })), status(422))
  for (const invalid of [{ afterSequence: -1 }, { afterSequence: 2147483648 }, { afterSequence: 0.5 }, { limit: 0 }, { limit: 101 }, { limit: '1' }, { limit: null }, { afterSequence: null }, { actorId: observer.id }]) await assert.rejects(() => as(token.plainTextToken, () => readPublicSafetyAudit(key, invalid as never)), status(422))

  const race = 'native-concurrent-cas'
  await make(race)
  const contenders = await Promise.allSettled([change(race, 1, 'pilot'), change(race, 1, 'observer')])
  assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = contenders.find(result => result.status === 'rejected')
  assert(rejected?.status === 'rejected' && status(409)(rejected.reason))
  assert.equal((await readMain(race)).version, 2)
  assert.equal((await auditMain(race)).entries.length, 2)
  await assert.rejects(() => change(race, 1), status(409))

  // Actual SQLite failure after membership and CAS writes must roll back both and the audit append.
  await database.db.unsafe("CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON public_safety_audits WHEN NEW.action = 'member-granted' BEGIN SELECT RAISE(ABORT, 'fixture audit persistence fault'); END")
  await assert.rejects(() => change(race, 2, 'evidence-custodian'), /fixture audit persistence fault/)
  await database.db.unsafe('DROP TRIGGER fixture_reject_audit')
  assert.equal((await readMain(race)).version, 2)
  assert.equal((await auditMain(race)).entries.length, 2)
  const winner = contenders.find(result => result.status === 'fulfilled')
  assert(winner?.status === 'fulfilled')
  assert.equal((await as(other.plainTextToken, () => readPublicSafetyIncident(race))).membership.role, winner.value.membership.role)
  assert.equal((await change(race, 2, 'evidence-custodian')).membership.version, 2)

  // Native request/RBAC caches are deliberately stale; native SQL inside the transaction wins.
  const rollback = new Error('fixture transaction rollback')
  await as(token.plainTextToken, async () => {
    assert.equal(await Auth.tokenCan('public-safety:coordinate'), true)
    assert.equal(await Rbac.hasPermission(coordinator.id, 'public-safety:access', 'web'), true)
    const store = createBqbRbacStore()
    for (const state of ['permission', 'token', 'credential'] as const) {
      await assert.rejects(() => transaction(async tx => {
        if (state === 'permission') {
          const permission = await store.findPermissionByName('public-safety:access', 'web')
          assert(permission)
          await tx.deleteFrom('user_permissions').where('user_id', '=', coordinator.id).where('permission_id', '=', permission.id).execute()
          assert.equal(await Rbac.hasPermission(coordinator.id, 'public-safety:access', 'web'), true)
        }
        if (state === 'token') {
          await tx.updateTable('oauth_access_tokens').set({ revoked: true }).where('id', '=', token.accessToken.id).execute()
          assert.equal(await Auth.tokenCan('public-safety:coordinate'), true)
        }
        if (state === 'credential') await tx.updateTable('users').set({ password_changed_at: sqlDateTime(new Date(Date.now() + 1000)) }).where('id', '=', coordinator.id).execute()
        await assert.rejects(() => closePublicSafetyIncident(race, { expectedVersion: 3 }), status(state === 'permission' ? 403 : 401))
        throw rollback
      }), error => error === rollback)
      assert.equal((await readPublicSafetyIncident(race)).version, 3)
      assert.equal((await readPublicSafetyAudit(race)).entries.length, 3)
    }
  })

  // Gate's real after-hook commits revocation after successful preflight and before the mutation transaction.
  // These cases fail if mutation() trusts the preflight result instead of checking native state again.
  for (const state of ['token', 'permission', 'membership'] as const) {
    const interleaveKey = `after-preflight-${state}`
    await make(interleaveKey)
    await change(interleaveKey, 1, 'evidence-custodian')
    const credential = await createToken(coordinator.id, `after preflight ${state}`, ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
    const before = await as(other.plainTextToken, () => readPublicSafetyIncident(interleaveKey))
    const beforeAudit = await as(other.plainTextToken, () => readPublicSafetyAudit(interleaveKey))
    let armed = true, successfulPreflights = 0
    Gate.after(async (user, ability, allowed, args) => {
      if (!armed || ability !== 'public-safety:close' || args[0] !== interleaveKey) return
      assert.equal(allowed, true, 'revocation must occur after an allowed native Gate preflight')
      assert.equal(user?.id, coordinator.id)
      armed = false
      successfulPreflights++
      if (state === 'token') await revokeToken(credential.plainTextToken)
      if (state === 'permission') await Rbac.revokePermission(coordinator.id, 'public-safety:access', 'web')
      if (state === 'membership') {
        const incident = await database.db.primary.selectFrom('public_safety_incidents').select('id').where('incident_key', '=', interleaveKey).executeTakeFirst()
        assert(incident)
        // External account administration can invalidate even the sole coordinator's current membership.
        await database.db.primary.updateTable('public_safety_incident_members').set({ active: false }).where('incident_id', '=', incident.id).where('user_id', '=', coordinator.id).execute()
      }
    })
    try {
      await assert.rejects(() => as(credential.plainTextToken, () => closePublicSafetyIncident(interleaveKey, { expectedVersion: before.version })), status(state === 'token' ? 401 : 403))
      assert.equal(successfulPreflights, 1)
      assert.equal(armed, false)
      assert.deepEqual(await as(other.plainTextToken, () => readPublicSafetyIncident(interleaveKey)), before)
      assert.deepEqual(await as(other.plainTextToken, () => readPublicSafetyAudit(interleaveKey)), beforeAudit)
    }
    finally {
      armed = false
      if (state === 'permission') await Rbac.givePermission(coordinator.id, 'public-safety:access', 'web')
    }
  }
  console.log('PASS native revocation after successful Gate preflight refuses mutation without version or audit changes')

  const retention = 'native-retention-boundary'
  const retained = configFor(retention)
  retained.retention = { ...config.retention, expiresAt: new Date(Date.now() + 1500).toISOString() }
  await as(token.plainTextToken, () => createPublicSafetyIncident({ config: retained }))
  assert.equal((await readMain(retention)).status, 'active')
  await Bun.sleep(Math.max(0, Date.parse(retained.retention.expiresAt) - Date.now()))
  for (const action of [() => readPublicSafetyIncident(retention), () => readPublicSafetyAudit(retention), () => closePublicSafetyIncident(retention, { expectedVersion: 1 }), () => changePublicSafetyMembership(retention, { expectedVersion: 1, userId: observer.id, role: 'observer' })]) await assert.rejects(() => as<unknown>(token.plainTextToken, action), status(404))
  for (const expiresAt of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 367 * 86400000).toISOString()]) await assert.rejects(() => as(token.plainTextToken, () => createPublicSafetyIncident({ config: { ...configFor('invalid-retention'), retention: { ...config.retention, expiresAt } } })), status(422))

  const longAudit = 'native-unbounded-history'
  await make(longAudit)
  for (let version = 1; version <= 1001; version++) await change(longAudit, version, version % 2 ? 'pilot' : 'observer')
  assert.equal((await readMain(longAudit)).version, 1002)
  let cursor = 0, total = 0, hasMore = true
  while (hasMore) {
    const page = await as(token.plainTextToken, () => readPublicSafetyAudit(longAudit, { afterSequence: cursor }))
    assert(page.entries.length <= 100)
    assert.equal(page.entries[0]?.sequence, cursor + 1)
    total += page.entries.length
    cursor = page.cursor
    hasMore = page.hasMore
  }
  assert.equal(total, 1002)
  assert.equal(cursor, 1002)
  assert.deepEqual(await as(token.plainTextToken, () => readPublicSafetyAudit(longAudit, { afterSequence: cursor })), { entries: [], cursor, hasMore: false })

  await writeFile(join(process.cwd(), 'durability.json'), JSON.stringify({ key: config.id, token: token.plainTextToken }), { mode: 0o600 })
  const child = Bun.spawn([process.execPath, `--config=${join(process.cwd(), 'bunfig.toml')}`, '--no-env-file', import.meta.path], { cwd: process.cwd(), env: { ...process.env, INCIDENT_DURABILITY_READ: '1' }, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(exitCode, 0, `${stdout}\n${stderr}`)
  assert(stdout.includes('PASS incident survives a fresh process'))
  console.log('PASS native incident creation, membership, audit and policy')
  console.log('PASS native revocation, retention, CAS, rollback, pagination and durability')
  }
}
finally { await database.closeDatabaseConnection() }
