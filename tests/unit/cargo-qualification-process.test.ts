import { expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runBoundedHostProcess } from '../../resources/functions/host/process'

// The real qualifier/child seam catches unbounded capture and leaked processes;
// it does not qualify the modeled vehicle or CI runner memory consumption.
for (const stream of ['stdout', 'stderr'] as const) {
  test(`the cargo qualifier rejects ${stream} overflow and reaps its executable`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'drone-cargo-qualifier-'))
    const binary = join(root, 'fixture'), pidFile = join(root, 'child.pid')
    try {
      await Bun.write(binary, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.${stream}.write('x'.repeat(32768)); await Bun.sleep(60000)\n`)
      await chmod(binary, 0o755)
      const result = await runBoundedHostProcess([process.execPath, resolve('scripts/qualify-cargo-cli.ts'), binary, join(root, 'output')], { timeoutMs: 5000, stdoutBytes: 4096, stderrBytes: 16384, label: 'Cargo qualifier fixture' })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain(`${stream} exceeds byte limit`)
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(Number.isSafeInteger(pid)).toBe(true)
      expect(() => process.kill(pid, 0)).toThrow()
      expect(await Bun.file(join(root, 'output/receipt.json')).exists()).toBe(false)
      expect(await Bun.file(join(root, 'output/nominal.stdout')).exists()).toBe(false)
    }
    finally { await rm(root, { recursive: true, force: true }) }
  }, 10000)
}

test('strict bounded process capture rejects malformed UTF8 after reaping the child and preserves valid bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-cargo-encoding-')), pidFile = join(root, 'child.pid')
  const options = { timeoutMs: 5000, stdoutBytes: 16384, stderrBytes: 1024, strictUtf8: true, label: 'Cargo encoding fixture' }
  try {
    await expect(runBoundedHostProcess([process.execPath, '-e', `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.write(Bun.stdout, new Uint8Array([255]))`], options)).rejects.toThrow()
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(Number.isSafeInteger(pid)).toBe(true)
    expect(() => process.kill(pid, 0)).toThrow()
    const result = await runBoundedHostProcess([process.execPath, '-e', `await Bun.write(Bun.stdout, new Uint8Array([239,187,191,195,169,10]))`], options)
    expect(result.exitCode).toBe(0)
    expect(Buffer.from(result.stdout, 'utf8')).toEqual(Buffer.from([239, 187, 191, 195, 169, 10]))
    expect(result.stderr).toBe('')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 15000)
