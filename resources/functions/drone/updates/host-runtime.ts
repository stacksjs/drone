import type { RuntimeFrame } from '../runtime/protocol'
import type { RuntimeFirmwareStage } from './staging'
import { realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { runRuntimeBench } from '../runtime/bench'
import { decodeRuntimeFrame } from '../runtime/protocol'
import { directory, imageLimit, regularFile, sha256, syncDirectory, writeExclusive } from './files'
import { runBoundedHostProcess } from '../../host/process'

/** Read-only preflight, including build paths whose final directories do not exist yet. */
export function runtimeHostBuildProject(project: string, excluded: readonly string[]) {
  const root = realpathSync(resolve(project))
  directory(root)
  const parts = ['storage', 'runtime-build', 'host']
  let output = root
  for (let index = 0; index < parts.length; index++) {
    const next = join(output, parts[index]!)
    try { directory(next); output = realpathSync(next) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      output = join(output, ...parts.slice(index)); break
    }
  }
  for (const reference of excluded) {
    const protectedRoot = realpathSync(reference)
    const child = relative(protectedRoot, output), ancestor = relative(output, protectedRoot)
    if (!child || (!child.startsWith(`..${sep}`) && child !== '..') || (!ancestor.startsWith(`..${sep}`) && ancestor !== '..')) throw new Error('Host build output must be separate from repository and protected trust state')
  }
  return root
}

async function sourceCommand(project: string, args: string[]) {
  const result = await runBoundedHostProcess(['git', '-C', project, ...args], { cwd: project, timeoutMs: 10000, stdoutBytes: 65536, stderrBytes: 65536, label: 'Host trial source inspection' })
  if (result.exitCode !== 0 || result.stderr) throw new Error('Host trial source inspection failed', { cause: { exitCode: result.exitCode, stderr: result.stderr } })
  return result.stdout.trim()
}

/** Internal coordinator operation: execute only bytes matching the actual owned neutral host build. */
export async function observeRuntimeHostImage(options: {
  project: string
  description: Readonly<RuntimeFirmwareStage>
  candidateImage: string
  slotDirectory: string
  protectedDirectories: readonly string[]
  onReady: () => Promise<void>
  onRequest: (line: string) => Promise<void>
  onStatus: (status: Readonly<RuntimeFrame>) => Promise<void>
}) {
  const project = runtimeHostBuildProject(options.project, options.protectedDirectories), description = options.description
  if (description.platform !== 'host-neutral-bench-v1') throw new Error('Only owned neutral host images support host trials')
  const image = regularFile(options.candidateImage, imageLimit)
  if (image.length !== description.length || sha256(image) !== description.sha256) throw new Error('Host trial candidate image changed')
  async function checkSource() {
    if (await sourceCommand(project, ['rev-parse', '--show-toplevel']) !== project
      || await sourceCommand(project, ['rev-parse', 'HEAD']) !== description.sourceRevision
      || await sourceCommand(project, ['status', '--porcelain=v1', '--untracked-files=all', '--', 'firmware/runtime'])) throw new Error('Host trial requires the signed clean firmware source revision')
  }
  await checkSource()
  let artifact: string | undefined
  let started = 0
  let stop: RuntimeFrame | undefined, last: Readonly<RuntimeFrame> | undefined
  const report = await runRuntimeBench({ project, ticks: 100, fault: 'none',
    async onBuild(path) {
      await checkSource()
      const built = regularFile(path, imageLimit)
      if (!built.equals(image)) throw new Error('Signed host image does not match the actual owned neutral build')
      artifact = path
      directory(options.slotDirectory)
      writeExclusive(join(options.slotDirectory, 'image.bin'), image)
      syncDirectory(options.slotDirectory)
      if (!regularFile(join(options.slotDirectory, 'image.bin'), imageLimit).equals(built)) throw new Error('Host slot image readback failed')
      await options.onReady()
      if (!regularFile(path, imageLimit).equals(image)) throw new Error('Owned host executable changed before launch')
      started = performance.now()
    },
    async onRequest(line) {
      await options.onRequest(line)
      if (line.startsWith('frame ')) {
        const command = decodeRuntimeFrame(Uint8Array.fromHex(line.slice(6)))
        if (command.kind === 'stop') stop = command
      }
    },
    async onStatus(status) {
      await options.onStatus(status)
      if (last && status.sequence <= last.sequence) throw new Error('Host trial status sequence rejected')
      last = status
    },
  })
  if (!artifact || performance.now() - started > 30000 || !regularFile(artifact, imageLimit).equals(image)
    || !regularFile(join(options.slotDirectory, 'image.bin'), imageLimit).equals(image)) throw new Error('Host trial image or duration rejected after execution')
  if (!report.cleanProcessExit || !stop || !last || last.bootId !== stop.bootId || last.sessionId !== stop.sessionId || last.sessionId === 0n
    || last.flags !== 67 || last.leaseUs !== 0 || last.deadlineMisses !== 0 || last.ticks !== 100 || last.sampleTimeUs !== 100000n
    || last.stateBytes < 1 || last.stateBytes > 128 || last.maxExecutionUs > 500) throw new Error('Host trial stop response rejected')
  return report
}
