import { retainedPreview } from '../../helpers/public-safety-retained'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { decode } from 'ts-images'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
const { database, User, root } = await setupIncidentDatabase()
process.env.PUBLIC_SAFETY_MANAGED_ROOT = join(root, 'managed-private')
await mkdir(process.env.PUBLIC_SAFETY_MANAGED_ROOT, { mode: 0o700 })
const managed = await import('../../../resources/functions/drone/public-safety/managed/service')
const retention = await import('../../../resources/functions/drone/public-safety/retention/service')
const access = await import('../../../resources/functions/drone/public-safety/access/service')
const records = await import('../../../resources/functions/drone/public-safety/access/records')
const { publicSafetyManagedGate } = await import('../../../resources/functions/drone/public-safety/managed/policy')
const { publicSafetyRetentionGate } = await import('../../../resources/functions/drone/public-safety/retention/policy')
const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { incidentAbilities } = await import('../../../resources/functions/drone/public-safety/access/types')
const { managedAbilities } = await import('../../../resources/functions/drone/public-safety/managed/types')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken } = await import('@stacksjs/auth/tokens')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
for (const ability of ['read', 'manage', 'revoke'] as const) Gate.define(`public-safety:retention-${ability}`, (user, key) => publicSafetyRetentionGate(user, key, ability))
for (const ability of managedAbilities) Gate.define(`public-safety:managed-${ability}`, (user, key) => publicSafetyManagedGate(user, key, ability))
const as = <T>(token: string, work: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), work)
try {
  const coordinator = await User.create({ name: 'Managed Coordinator', email: 'managed-coordinator@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(coordinator.id, permission, 'web') }
  const token = (await createToken(coordinator.id, 'managed fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  await as(token, async () => {
    const config = examplePublicSafetyConfig(); config.id = 'managed-lifecycle'; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
    const run = simulatePublicSafety({ config, seconds: 10 })
    await access.createPublicSafetyIncident({ config })
    const source = await records.registerPublicSafetySource(config.id, { expectedVersion: 1, recording: run })
    const preview = retainedPreview(await retention.previewPublicSafetyRetention(config.id))
    await retention.enrollPublicSafetyRetention(config.id, { expectedVersion: 2, policyVersion: 'local-managed-v1', inventoryDigest: preview.inventoryDigest, requestId: randomUUID() })
    const body = { expectedVersion: 3, expectedRetentionVersion: 1, sourceDigest: source.source.digest, datasetProfile: 'owned-public-safety-dataset-v1', requestId: randomUUID() }
    const created = await managed.createPublicSafetyManagedDataset(config.id, body)
    assert.equal(created.artifact.state, 'complete'); assert.equal(created.artifact.version, 3); assert.equal(created.artifact.incidentVersion, 6)
    assert.equal(created.event.actorUserId, coordinator.id)
    assert.equal(created.artifact.ownershipRecorded, true)
    assert.equal(created.artifact.sourceIdentityAuthenticated, false)
    assert.equal((await retention.readPublicSafetyRetention(config.id)).version, 1)
    const replayed = await managed.createPublicSafetyManagedDataset(config.id, body)
    assert.equal(replayed.replayed, true); assert.equal(replayed.event.action, 'intent-recorded'); assert.equal(replayed.artifact.incidentVersion, 6)
    const page = await managed.listPublicSafetyManagedArtifacts(config.id)
    assert.deepEqual(page.entries.map(row => row.key), [created.artifact.key])
    assert.deepEqual((await managed.listPublicSafetyManagedArtifacts(config.id, { requestId: body.requestId })).entries, page.entries)
    const read = await managed.readPublicSafetyManagedArtifact(config.id, created.artifact.key)
    const recording = read.files.find(file => file.role === 'recording')!
    const data = await managed.readPublicSafetyManagedArtifactFile(config.id, created.artifact.key, recording.id)
    assert.equal(new TextDecoder().decode(data.bytes), `${publicSafetyRecordingData(run)}\n`)
    assert.equal(createHash('sha256').update(data.bytes).digest('hex'), recording.sha256)
    assert.equal(data.filename, 'recording.json')
    const manifestFile = read.files.find(file => file.role === 'manifest')!
    const manifest = JSON.parse(new TextDecoder().decode((await managed.readPublicSafetyManagedArtifactFile(config.id, created.artifact.key, manifestFile.id)).bytes))
    assert.equal(manifest.identityAuthenticated, false); assert.equal(manifest.retentionDeletionEnforced, false)
    for (const role of ['thermal', 'support', 'visible'] as const) {
      const file = read.files.find(item => item.role === role)!
      const download = await managed.readPublicSafetyManagedArtifactFile(config.id, created.artifact.key, file.id)
      assert.equal(download.bytes.length, file.bytes)
      const capture = run.captures[0]!
      if (role === 'support') assert.deepEqual(download.bytes, capture.support)
      if (role === 'thermal') {
        const view = new DataView(download.bytes.buffer, download.bytes.byteOffset, download.bytes.byteLength)
        for (let n = 0; n < capture.thermalCentiKelvin.length; n++) assert.equal(view.getUint16(n * 2, true), capture.thermalCentiKelvin[n])
      }
      if (role === 'visible') {
        const image = await decode(download.bytes)
        assert.equal(image.width, run.survey.captures[0]!.width)
        assert.equal(image.height, run.survey.captures[0]!.height)
        assert.deepEqual(Array.from(image.data), Array.from(run.survey.captures[0]!.rgba))
      }
    }
    assert.deepEqual((await managed.listPublicSafetyManagedArtifactEvents(config.id, created.artifact.key)).entries.map(row => row.action), ['intent-recorded', 'ownership-recorded', 'published'])
    const reconciled = await managed.reconcilePublicSafetyManagedArtifact(config.id, created.artifact.key, { expectedVersion: 6, expectedArtifactVersion: 3, requestId: randomUUID() })
    assert.equal(reconciled.artifact.state, 'complete'); assert.equal(reconciled.artifact.version, 5); assert.equal(reconciled.artifact.incidentVersion, 8)
    const row = (await database.db.selectFrom('public_safety_managed_artifacts').selectAll().execute())[0]!
    const ledger = JSON.parse(String(row.receipt_json))
    assert.equal((await readFile(ledger.completedManifest, 'utf8')).length > 0, true)
    assert(BigInt(ledger.root.birthtimeNs) > 0n)
    const heldReader = openSync(join(ledger.directory, 'recording.json'), 'r')
    try {
      assert.deepEqual((await managed.readPublicSafetyManagedArtifactFile(config.id, created.artifact.key, recording.id)).bytes, data.bytes, 'a legitimate concurrent file reader is compatible with scoped mount inspection')
    }
    finally { closeSync(heldReader) }
    assert.equal((retainedPreview(await retention.previewPublicSafetyRetention(config.id))).managedArtifactCount, 1)
  })
  console.log('PASS actual native managed source-derived dataset publication, replay, bytes and read-only reconciliation')
}
finally { await database.closeDatabaseConnection() }
