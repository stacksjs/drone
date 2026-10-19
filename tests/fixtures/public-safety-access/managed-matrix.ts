import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { closeSync, openSync, writeFileSync, unlinkSync, renameSync, symlinkSync, linkSync, chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { database, actor, as, seed, status, managed, access, retention, createToken, root } from './managed-context'
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
try {
  const coordinator = await actor('matrix-coordinator'), token = coordinator.token.plainTextToken
  await as(token, async () => {
    const fixture = await seed('managed-matrix'), key = fixture.config.id
    const version = async () => (await access.readPublicSafetyIncident(key)).version
    const actors = new Map<string, Awaited<ReturnType<typeof actor>>>()
    for (const role of ['pilot', 'observer', 'reviewer', 'evidence-custodian', 'outsider'] as const) {
      const account = await actor(`managed-${role}`); actors.set(role, account)
      if (role !== 'outsider') await access.changePublicSafetyMembership(key, { expectedVersion: await version(), userId: account.user.id, role })
    }
    const body = { ...fixture.body, expectedVersion: await version() }
    const created = await managed.createPublicSafetyManagedDataset(key, body)
    const read = await managed.readPublicSafetyManagedArtifact(key, created.artifact.key), file = read.files.find(item => item.role === 'recording')!
    for (const [role, account] of actors) await as(account.token.plainTextToken, async () => {
      if (role === 'outsider') {
        for (const action of [async () => managed.listPublicSafetyManagedArtifacts(key), async () => managed.readPublicSafetyManagedArtifact(key, created.artifact.key), async () => managed.readPublicSafetyManagedArtifactFile(key, created.artifact.key, file.id), async () => managed.listPublicSafetyManagedArtifactEvents(key, created.artifact.key)]) await assert.rejects(action, status(403))
      }
      else {
        assert.equal((await managed.listPublicSafetyManagedArtifacts(key)).entries.length, 1)
        assert.equal((await managed.readPublicSafetyManagedArtifact(key, created.artifact.key)).files.length, 6)
        assert.equal((await managed.readPublicSafetyManagedArtifactFile(key, created.artifact.key, file.id)).bytes.length, file.bytes)
        if (role === 'evidence-custodian') assert.equal((await managed.listPublicSafetyManagedArtifactEvents(key, created.artifact.key)).entries.length, 3)
        else await assert.rejects(async () => managed.listPublicSafetyManagedArtifactEvents(key, created.artifact.key), status(403))
      }
      if (role !== 'evidence-custodian') {
        await assert.rejects(async () => managed.createPublicSafetyManagedDataset(key, { ...body, expectedVersion: await version(), requestId: randomUUID() }), status(403))
        await assert.rejects(async () => managed.reconcilePublicSafetyManagedArtifact(key, created.artifact.key, { expectedVersion: await version(), expectedArtifactVersion: 3, requestId: randomUUID() }), status(403))
      }
    })
    const readonly = await createToken(coordinator.user.id, 'read only', ['public-safety:read'], { withRefreshToken: false })
    const coordinateOnly = await createToken(coordinator.user.id, 'coordinate only', ['public-safety:coordinate'], { withRefreshToken: false })
    await as(readonly.plainTextToken, async () => {
      assert.equal((await managed.listPublicSafetyManagedArtifacts(key)).entries.length, 1)
      await assert.rejects(async () => managed.createPublicSafetyManagedDataset(key, { ...body, expectedVersion: await version(), requestId: randomUUID() }), status(403))
      await assert.rejects(async () => managed.reconcilePublicSafetyManagedArtifact(key, created.artifact.key, { expectedVersion: await version(), expectedArtifactVersion: 3, requestId: randomUUID() }), status(403))
    })
    await as(coordinateOnly.plainTextToken, () => assert.rejects(async () => managed.listPublicSafetyManagedArtifacts(key), status(403)))
    const custodian = actors.get('evidence-custodian')!
    const second = await as(custodian.token.plainTextToken, async () => managed.createPublicSafetyManagedDataset(key, { ...body, expectedVersion: await version(), requestId: randomUUID() }))
    assert.equal(second.artifact.requesterUserId, custodian.user.id)
    await as(custodian.token.plainTextToken, () => assert.rejects(async () => managed.createPublicSafetyManagedDataset(key, body), status(409)))
    assert.equal((await managed.createPublicSafetyManagedDataset(key, { requestId: body.requestId, sourceDigest: body.sourceDigest, datasetProfile: body.datasetProfile, expectedRetentionVersion: body.expectedRetentionVersion, expectedVersion: body.expectedVersion })).replayed, true)
    await assert.rejects(async () => managed.createPublicSafetyManagedDataset(key, { ...body, expectedVersion: body.expectedVersion + 1 }), status(409))
    let traps = 0
    const getter = { ...body }; Object.defineProperty(getter, 'sourceDigest', { enumerable: true, get() { traps++; return body.sourceDigest } })
    const proxy = new Proxy(body, { ownKeys() { traps++; return Reflect.ownKeys(body) }, getPrototypeOf() { traps++; return Object.prototype } })
    for (const input of [getter, proxy, { ...body, actorUserId: coordinator.user.id }, { ...body, root: root }, { ...body, filename: 'uncontrolled' }, { ...body, datasetProfile: 'other' }, { ...body, requestId: body.requestId.toUpperCase() }]) await assert.rejects(async () => managed.createPublicSafetyManagedDataset(key, input), status(422))
    await assert.rejects(async () => managed.listPublicSafetyManagedArtifacts(key, new Proxy({}, { ownKeys() { traps++; return [] } })), status(422))
    assert.equal(traps, 0)
    const other = await seed('other-managed-matrix')
    await assert.rejects(async () => managed.readPublicSafetyManagedArtifact(other.config.id, created.artifact.key), status(404))
    await assert.rejects(async () => managed.readPublicSafetyManagedArtifactFile(other.config.id, created.artifact.key, file.id), status(404))
    await assert.rejects(async () => managed.listPublicSafetyManagedArtifactEvents(other.config.id, created.artifact.key), status(404))
    await assert.rejects(async () => managed.createPublicSafetyManagedDataset(other.config.id, { ...other.body, sourceDigest: body.sourceDigest }), status(404))
    const source = writer.query('SELECT id, canonical_json FROM public_safety_sources WHERE digest=?').get(body.sourceDigest) as { id: number, canonical_json: string }
    writer.query('UPDATE public_safety_sources SET canonical_json=? WHERE id=?').run('{}', source.id)
    try {
      assert.equal((await managed.listPublicSafetyManagedArtifacts(key)).entries.length, 2, 'metadata discovery never replays private source')
      assert.equal((await managed.readPublicSafetyManagedArtifact(key, created.artifact.key)).files.length, 6)
      await assert.rejects(async () => managed.createPublicSafetyManagedDataset(key, { ...body, expectedVersion: await version(), requestId: randomUUID() }), status(409))
    }
    finally { writer.query('UPDATE public_safety_sources SET canonical_json=? WHERE id=?').run(source.canonical_json, source.id) }
    const owned = writer.query('SELECT receipt_json FROM public_safety_managed_artifacts WHERE artifact_key=?').get(created.artifact.key) as { receipt_json: string }
    const receipt = JSON.parse(owned.receipt_json), recording = join(receipt.directory, 'recording.json'), backup = join(root, 'original-recording')
    const download = async () => managed.readPublicSafetyManagedArtifactFile(key, created.artifact.key, file.id)
    const original = (await download()).bytes
    const extra = join(receipt.directory, 'unexpected.txt')
    writeFileSync(extra, 'unknown data', { mode: 0o600 }); await assert.rejects(download, status(409)); assert(existsSync(extra)); unlinkSync(extra)
    const fd = openSync(recording, 'r')
    try { assert.deepEqual((await download()).bytes, original) }
    finally { closeSync(fd) }
    const beforeFd = readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length
    for (let index = 0; index < 5; index++) await download()
    const afterFd = readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length
    assert.equal(afterFd, beforeFd, 'bounded downloads close all owned descriptors')
    const linked = join(root, 'external-hardlink'); linkSync(recording, linked)
    try { await assert.rejects(download, status(409)); assert(existsSync(linked)) } finally { unlinkSync(linked) }
    chmodSync(recording, 0o644); try { await assert.rejects(download, status(409)) } finally { chmodSync(recording, 0o600) }
    renameSync(recording, backup)
    try {
      await assert.rejects(download, status(409)); assert(!existsSync(recording), 'read never recreates a missing registered inode')
      symlinkSync(backup, recording); await assert.rejects(download, status(409)); unlinkSync(recording)
      writeFileSync(recording, original, { mode: 0o600 }); await assert.rejects(download, status(409)); unlinkSync(recording)
    }
    finally { renameSync(backup, recording) }
    writeFileSync(recording, new Uint8Array(original.length).fill(65)); await assert.rejects(download, status(409)); writeFileSync(recording, original)
    writeFileSync(recording, new Uint8Array(original.length + 1)); await assert.rejects(download, status(409)); writeFileSync(recording, original)
    const rootBackup = `${process.env.PUBLIC_SAFETY_MANAGED_ROOT}-original`
    renameSync(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, rootBackup); mkdirSync(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, { mode: 0o700 })
    try { await assert.rejects(download, status(409)) }
    finally { const { rmdirSync } = await import('node:fs'); rmdirSync(process.env.PUBLIC_SAFETY_MANAGED_ROOT!); renameSync(rootBackup, process.env.PUBLIC_SAFETY_MANAGED_ROOT!) }
    assert.deepEqual((await download()).bytes, original)
    writeFileSync(extra, 'unknown data', { mode: 0o600 })
    const blocked = await managed.reconcilePublicSafetyManagedArtifact(key, created.artifact.key, { expectedVersion: await version(), expectedArtifactVersion: 3, requestId: randomUUID() })
    assert.equal(blocked.artifact.state, 'blocked'); assert.equal((await Bun.file(extra).text()), 'unknown data')
    assert.equal((await retention.previewPublicSafetyRetention(key)).managedArtifactCount, 2)
    await access.closePublicSafetyIncident(key, { expectedVersion: await version() })
    assert.equal((await managed.listPublicSafetyManagedArtifacts(key)).entries.length, 2)
    assert.equal((await managed.readPublicSafetyManagedArtifact(key, second.artifact.key)).artifact.state, 'complete')
    await assert.rejects(async () => managed.createPublicSafetyManagedDataset(key, { ...body, expectedVersion: await version(), requestId: randomUUID() }), status(409))
    await assert.rejects(async () => managed.reconcilePublicSafetyManagedArtifact(key, second.artifact.key, { expectedVersion: await version(), expectedArtifactVersion: 3, requestId: randomUUID() }), status(409))
  })
  console.log('PASS actual managed role/scope matrix, canonical replay, cross-incident denial, source verification and real namespace/corruption/FD boundaries')
}
finally { writer.close(); await database.closeDatabaseConnection() }
