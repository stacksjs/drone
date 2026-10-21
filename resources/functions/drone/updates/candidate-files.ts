import { mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { TargetFile } from 'tuf-js'
import { directory, imageLimit, regularFile, safePath, syncDirectory, syncTree, writeExclusive } from './files'

/** Internal candidate file-format helpers. They do not grant firmware selection authority. */
export function runtimeCandidateOutput(output: string, excluded: readonly string[]) {
  const requested = resolve(output), parent = realpathSync(dirname(requested))
  directory(parent)
  const destination = join(parent, basename(requested))
  for (const source of excluded) {
    const root = realpathSync(source)
    const child = relative(root, destination), ancestor = relative(destination, root)
    if (!child || (!child.startsWith(`..${sep}`) && child !== '..') || (!ancestor.startsWith(`..${sep}`) && ancestor !== '..')) throw new Error('Candidate output must be separate from repository and protected trust state')
  }
  return destination
}

/** Caller owns SDK verification. Recheck actual image bytes before writing the completion marker. */
export async function finishRuntimeCandidate(output: string, info: TargetFile, receipt: unknown, files: ReadonlyMap<string, Buffer>) {
  await info.verify(Readable.from(regularFile(join(output, 'image.bin'), imageLimit)))
  let total = 0
  for (const [path, bytes] of files) {
    safePath(path)
    if (!path.startsWith('metadata/') && !path.startsWith('targets/')) throw new Error('Invalid candidate repository entry')
    total += bytes.length
    if (total > 32 * 1024 * 1024 || files.size > 64) throw new Error('Candidate archive budget exceeded')
    const file = join(output, 'repository', path)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeExclusive(file, bytes)
  }
  syncTree(output)
  writeExclusive(join(output, 'stage.json'), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`))
  syncDirectory(output); syncDirectory(dirname(output))
}
