import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnWorkspaceFixture } from '../helpers/workspace-process'

for (const mode of ['version-fetch', 'version-json', 'target-fetch', 'target-json', 'browser-socket', 'page-socket', 'control-fetch', 'control-json', 'control-ok', 'ok', 'unwritable-diagnostic']) test(`native browser operation ${mode}`, async () => {
  const evidence = process.env.BROWSER_OPERATION_EVIDENCE
  if (evidence) await mkdir(resolve(evidence), { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(evidence ? resolve(evidence) : tmpdir(), 'drone-incident-access-browser-operation-'))
  let owned: ReturnType<typeof spawnWorkspaceFixture> | undefined
  let passed = false
  try {
    const config = join(root, 'bunfig.toml'), launcher = join(root, 'browser-peer')
    await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n', { mode: 0o600 })
    await writeFile(launcher, '#!/bin/sh\nexec "$BROWSER_PEER_BUN" --no-install "--config=$BROWSER_PEER_CONFIG" --no-env-file "$BROWSER_PEER_SOURCE" "$@"\n', { mode: 0o700 })
    const fixture = `${import.meta.dir}/../fixtures/public-safety-access`
    const peerMode = mode === 'unwritable-diagnostic' ? 'version-fetch' : mode
    owned = spawnWorkspaceFixture([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${fixture}/browser-operation-probe.ts`], root, { BROWSE_BROWSER: launcher, BROWSER_PEER_BUN: process.execPath, BROWSER_PEER_CONFIG: config, BROWSER_PEER_SOURCE: `${fixture}/browser-operation-peer.ts`, BROWSER_PEER_MODE: peerMode, BROWSER_OPERATION_UNWRITABLE_DIAGNOSTIC: mode === 'unwritable-diagnostic' ? 'true' : 'false' })
    const current = owned, watchdog = setTimeout(() => { void current.stop().catch(() => {}) }, 12000)
    try {
      const [code, stdout, stderr] = await Promise.all([owned.child.exited, new Response(owned.child.stdout as ReadableStream).text(), new Response(owned.child.stderr as ReadableStream).text()])
      await writeFile(join(root, 'fixture.stdout'), stdout, { mode: 0o600 }); await writeFile(join(root, 'fixture.stderr'), stderr, { mode: 0o600 })
      for (const line of stdout.split('\n')) if (line.startsWith('{"oracle":')) console.log(line)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('"peerReaped":true')
      expect(stdout).not.toContain('QA isolated Chrome exited unexpectedly')
      if (mode === 'ok' || mode === 'control-ok' || mode === 'unwritable-diagnostic') expect(stderr).toBe('')
      if (mode !== 'ok' && mode !== 'control-ok') {
        const stream = mode === 'unwritable-diagnostic' ? stdout : stderr
        const lines = stream.split('\n').filter(line => line.startsWith('{"oracle":"browser-operation-failure"')); expect(lines).toHaveLength(1)
        const observation = JSON.parse(lines[0]!)
        expect(observation.oracle).toBe('browser-operation-failure')
        expect(observation.operation).toBe(peerMode.startsWith('control-') ? peerMode.replace('control-', 'control-status-') : peerMode)
        expect(observation.phase).toBe(peerMode.startsWith('control-') ? 'workspace-control' : peerMode.startsWith('version') || peerMode === 'browser-socket' ? 'browser-start' : 'page-open')
        expect(peerMode.endsWith('-socket') ? ['other'] : ['TimeoutError', 'AbortError']).toContain(observation.nativeError)
        expect(observation.elapsedMs).toBeGreaterThanOrEqual(4900)
        expect(stream).not.toContain(root)
        expect(stream).not.toContain('http:')
        expect(stream).not.toContain('synthetic-peer-control')
      }
      passed = true
    }
    finally { clearTimeout(watchdog) }
  }
  finally {
    await owned?.stop()
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error('BROWSER_OPERATION_FIXTURE_RETAINED', root)
  }
}, 18000)
