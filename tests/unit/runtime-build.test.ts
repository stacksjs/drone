import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '../../resources/functions/drone/runtime/build'

test('actual CMake refusal identifies the build stage before any runtime test starts', async () => {
  const project = await mkdtemp(join(tmpdir(), 'drone-build-refusal-'))
  try {
    await mkdir(join(project, 'firmware/runtime'), { recursive: true })
    await writeFile(join(project, 'firmware/runtime/CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(controlled_refusal NONE)\nmessage(FATAL_ERROR "Controlled configure refusal")\n')
    await expect(buildRuntime({ project })).rejects.toThrow('Runtime build host configure: cmake exited 1')
  }
  finally { await rm(project, { recursive: true, force: true }) }
}, 10000)
