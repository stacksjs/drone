import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const metadataLimit = 512 * 1024
export const imageLimit = 16 * 1024 * 1024
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function safePath(path: string) {
  if (typeof path !== 'string' || path.length > 256 || !path.split('/').every(part => /^[a-z0-9][a-z0-9._-]{0,179}$/i.test(part) && part !== '.' && part !== '..')) throw new TypeError('Unsafe offline repository path')
}
export function regularFile(path: string, limit: number): Buffer {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > limit) throw new Error('Expected a nonempty bounded regular file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 1 || stat.size > limit || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Expected the same bounded regular file')
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset !== stat.size) throw new Error('Source file changed length while reading')
    return bytes.subarray(0, offset)
  }
  finally { closeSync(fd) }
}
export function directory(path: string) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a real directory')
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) throw new Error('Directories must be owned and not writable by other principals')
}
export function repositoryFile(root: string, path: string, limit: number) {
  safePath(path)
  directory(root)
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) directory(join(root, ...parts.slice(0, i)))
  return regularFile(join(root, ...parts), limit)
}
export function writeExclusive(path: string, bytes: Uint8Array) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset)
      if (count <= 0) throw new Error('No progress writing protected runtime data')
      offset += count
    }
    fsyncSync(fd)
  }
  finally { closeSync(fd) }
}
export function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) }
  finally { closeSync(fd) }
}
export function syncTree(path: string) {
  directory(path)
  for (const name of readdirSync(path)) {
    const child = join(path, name), stat = lstatSync(child)
    if (stat.isDirectory()) syncTree(child)
    else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected candidate entry')
      const fd = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(fd) }
      finally { closeSync(fd) }
    }
  }
  syncDirectory(path)
}
