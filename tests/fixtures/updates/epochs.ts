import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Metadata, MetaFile, Root, Snapshot, TargetFile, Targets, Timestamp } from '@tufjs/models'
import { digest, platform, signer, target } from './repository'

/** The same timestamp key survives a snapshot-only authority rotation. All keys are throwaway. */
export async function epochRepository(directory: string, duplicateSnapshotKey = false) {
  await mkdir(join(directory, 'metadata'), { recursive: true })
  const keys = { root: signer(), timestamp: signer(), snapshot: signer(), nextSnapshot: signer(), targets: signer() }
  const fields = { specVersion: '1.0.31', expires: '2035-01-01T00:00:00Z' }
  function root(version: number) {
    const data = new Root({ ...fields, version })
    for (const role of ['root', 'timestamp', 'snapshot', 'targets'] as const) data.addKey(version === 2 && role === 'snapshot' && !duplicateSnapshotKey ? keys.nextSnapshot.key : keys[role].key, role)
    if (version === 2 && duplicateSnapshotKey) data.roles.snapshot!.keyIDs.push(keys.snapshot.key.keyID)
    const metadata = new Metadata(data); metadata.sign(keys.root.sign)
    return Buffer.from(JSON.stringify(metadata.toJSON()))
  }
  const rootPath = join(directory, 'anchor.json'), anchor = root(1)
  await writeFile(rootPath, anchor)
  async function publish(epoch: 1 | 2, version: number, releaseSequence: number) {
    if (epoch === 2) await writeFile(join(directory, 'metadata/2.root.json'), root(2))
    const image = Buffer.from('synthetic epoch image, never execute or flash\n')
    const custom = { schema: 'drone-runtime-image-v1', platform, protocolVersion: 1, releaseSequence, sourceRevision: 'a'.repeat(40), profile: 'neutral-bench' }
    const targets = new Metadata(new Targets({ ...fields, version, targets: { [target]: new TargetFile({ path: target, length: image.length, hashes: { sha256: digest(image) }, unrecognizedFields: { custom: { drone: custom } } }) } }))
    targets.sign(keys.targets.sign)
    const targetBytes = Buffer.from(JSON.stringify(targets.toJSON()))
    const snapshot = new Metadata(new Snapshot({ ...fields, version, meta: { 'targets.json': new MetaFile({ version, length: targetBytes.length, hashes: { sha256: digest(targetBytes) } }) } }))
    snapshot.sign(epoch === 1 || duplicateSnapshotKey ? keys.snapshot.sign : keys.nextSnapshot.sign)
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot.toJSON()))
    const timestamp = new Metadata(new Timestamp({ ...fields, version, snapshotMeta: new MetaFile({ version, length: snapshotBytes.length, hashes: { sha256: digest(snapshotBytes) } }) }))
    timestamp.sign(keys.timestamp.sign)
    await writeFile(join(directory, 'metadata/timestamp.json'), JSON.stringify(timestamp.toJSON()))
    await writeFile(join(directory, `metadata/${version}.snapshot.json`), snapshotBytes)
    await writeFile(join(directory, `metadata/${version}.targets.json`), targetBytes)
  }
  return { rootPath, rootSha256: digest(anchor), publish }
}
