import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Key, Metadata, MetaFile, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } from '@tufjs/models'
import { canonicalize } from '@tufjs/canonical-json'

export const target = 'runtime/pico2-bench.bin'
export const platform = 'pico2-neutral-bench-v1'
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fields = { version: 1, specVersion: '1.0.31', expires: '2035-01-01T00:00:00Z' }

function signer(nonCanonical = false) {
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  const keyObject = { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: publicKey } }
  const keyID = digest(nonCanonical ? Buffer.from(publicKey, 'hex') : Buffer.from(canonicalize(keyObject)))
  const key = new Key({ keyID, keyType: 'ed25519', scheme: 'ed25519', keyVal: { public: publicKey } })
  return { key, sign: (data: Buffer) => new Signature({ keyID: key.keyID, sig: sign(null, data, pair.privateKey).toString('hex') }) }
}

/** Generated throwaway keys stay in memory. These bytes are a test payload, not firmware. */
export async function repository(directory: string, options: { custom?: Record<string, string | number | boolean>, expires?: string, rotate?: boolean, badRotation?: boolean, badTargetsSignature?: boolean, nonCanonicalRoot?: boolean, nonCanonicalRotation?: boolean, nonCanonicalDelegation?: boolean } = {}) {
  await mkdir(join(directory, 'metadata'), { recursive: true })
  await mkdir(join(directory, 'targets/runtime'), { recursive: true })
  const keys = { root: signer(options.nonCanonicalRoot), targets: signer(), snapshot: signer(), timestamp: signer() }
  const root = new Root(fields)
  for (const role of ['root', 'targets', 'snapshot', 'timestamp'] as const) root.addKey(keys[role].key, role)
  const rootMetadata = new Metadata(root)
  rootMetadata.sign(keys.root.sign)
  const rootBytes = Buffer.from(JSON.stringify(rootMetadata.toJSON()))
  await writeFile(join(directory, 'trusted-root.json'), rootBytes)
  if (options.rotate) {
    const nextKey = signer(options.nonCanonicalRotation), next = new Root({ ...fields, version: 2 })
    next.addKey(nextKey.key, 'root')
    for (const role of ['targets', 'snapshot', 'timestamp'] as const) next.addKey(keys[role].key, role)
    const rotated = new Metadata(next)
    if (!options.badRotation) rotated.sign(keys.root.sign)
    rotated.sign(nextKey.sign)
    await writeFile(join(directory, 'metadata/2.root.json'), JSON.stringify(rotated.toJSON()))
  }
  const image = Buffer.from('test payload only, never execute or flash\n')
  const imageHash = digest(image)
  const custom = { schema: 'drone-runtime-image-v1', platform, protocolVersion: 1, releaseSequence: 7, sourceRevision: 'a'.repeat(40), profile: 'neutral-bench', ...options.custom }
  const targets = new Metadata(new Targets({ ...fields, targets: { [target]: new TargetFile({ path: target, length: image.length, hashes: { sha256: imageHash }, unrecognizedFields: { custom: { drone: custom } } }) } }))
  if (options.nonCanonicalDelegation) {
    const delegated = signer(true)
    targets.signed.unrecognizedFields.delegations = { keys: { [delegated.key.keyID]: delegated.key.toJSON() }, roles: [] }
  }
  targets.sign(options.badTargetsSignature ? signer().sign : keys.targets.sign)
  const targetsBytes = Buffer.from(JSON.stringify(targets.toJSON()))
  const snapshot = new Metadata(new Snapshot({ ...fields, meta: { 'targets.json': new MetaFile({ version: 1, length: targetsBytes.length, hashes: { sha256: digest(targetsBytes) } }) } }))
  snapshot.sign(keys.snapshot.sign)
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot.toJSON()))
  const timestamp = new Metadata(new Timestamp({ ...fields, expires: options.expires ?? fields.expires, snapshotMeta: new MetaFile({ version: 1, length: snapshotBytes.length, hashes: { sha256: digest(snapshotBytes) } }) }))
  timestamp.sign(keys.timestamp.sign)
  await writeFile(join(directory, 'metadata/timestamp.json'), JSON.stringify(timestamp.toJSON()))
  await writeFile(join(directory, 'metadata/1.snapshot.json'), snapshotBytes)
  await writeFile(join(directory, 'metadata/1.targets.json'), targetsBytes)
  await writeFile(join(directory, 'targets/runtime', `${imageHash}.pico2-bench.bin`), image)
  return { rootPath: join(directory, 'trusted-root.json'), rootSha256: digest(rootBytes), imageHash, image, custom, imagePath: join(directory, 'targets/runtime', `${imageHash}.pico2-bench.bin`) }
}
