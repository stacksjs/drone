import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Actual disposable source repo with explicit faults and optional host-only file padding. */
export async function createHostSourceProject(root: string, options: { fault?: 'stop-session' | 'configure-output', imagePadding?: true } = {}) {
  const project = join(root, 'project')
  await mkdir(project, { mode: 0o700 })
  await mkdir(join(project, 'firmware'), { mode: 0o700 })
  await cp(join(import.meta.dir, '../../../firmware/runtime'), join(project, 'firmware/runtime'), { recursive: true })
  if (options.imagePadding) {
    const path = join(project, 'firmware/runtime/src/host.cpp'), source = await readFile(path, 'utf8')
    const entry = 'int main(int argc, char** argv) {'
    if (source.split(entry).length !== 2) throw new Error('Owned host entry no longer matches the large-image fixture')
    await writeFile(path, source.replace(entry, 'struct TestImagePadding { unsigned char first; unsigned char bytes[2 * 1024 * 1024]; unsigned char last; };\nvolatile TestImagePadding test_image_padding{1, {}, 1};\n' + entry + '\n    if (test_image_padding.first != 1 || test_image_padding.last != 1) return 2;'))
  }
  if (options.fault === 'stop-session') {
    const path = join(project, 'firmware/runtime/src/host.cpp'), source = await readFile(path, 'utf8')
    const original = 'drone::encode(runtime.status(now), bytes);'
    if (!source.includes(original)) throw new Error('Owned host source no longer matches the deliberate stop-session fixture')
    await writeFile(path, source.replace(original, 'auto status = runtime.status(now); if (std::strncmp(line, "frame 44520103", 14) == 0) ++status.session; drone::encode(status, bytes);'))
  }
  if (options.fault === 'configure-output') {
    const path = join(project, 'firmware/runtime/CMakeLists.txt')
    await writeFile(path, `${await readFile(path, 'utf8')}\nif(EXISTS "\${CMAKE_BINARY_DIR}/drone-output-overflow-fixture")\n  string(REPEAT "fixture-only-output " 180000 DRONE_OVERFLOW_FIXTURE)\n  message(STATUS "\${DRONE_OVERFLOW_FIXTURE}")\nendif()\n`)
  }
  async function git(args: string[]) {
    const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Chris Breuer', '-c', 'user.email=chris@stacksjs.com', '-C', project, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    try {
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code) throw new Error('Isolated host fixture Git command failed', { cause: { code, errors } })
      return output.trim()
    }
    finally { clearTimeout(timer) }
  }
  await git(['init', '-b', 'codex/host-health-fixture'])
  await git(['add', 'firmware'])
  await git(['commit', '-m', 'test: prepare host health fixture'])
  return { project, sourceRevision: await git(['rev-parse', 'HEAD']) }
}
