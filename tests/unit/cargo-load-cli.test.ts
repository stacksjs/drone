import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { spawn } from 'node:child_process'

test('native cargo command emits one exact bounded centered summary with actual raw metrics and no delivery claims', async () => {
  const result = await command(['cargo:load-bench']).withTimeout(30000)
  expect(result.exitCode).toBe(0)
  expect(result.timedOut).toBe(false)
  const summary = JSON.parse(result.stdout)
  expect(Object.keys(summary)).toEqual(['version', 'evidence', 'profile', 'scenario', 'status', 'reason', 'physicalFlightEnabled', 'boardOutputsInhibited', 'identityAuthenticated', 'capabilities', 'model', 'counts', 'separation', 'metrics', 'final'])
  expect(summary.evidence).toBe('owned-airborne-cargo-load-characterization')
  expect(summary.profile).toBe('forward-point-load-v1')
  expect(summary.scenario).toBe('centered-carried')
  expect(summary.status).toBe('characterized')
  expect(summary.reason).toBeNull()
  expect(summary.physicalFlightEnabled).toBe(false)
  expect(summary.boardOutputsInhibited).toBe(true)
  expect(summary.identityAuthenticated).toBe(false)
  expect(summary.capabilities).toEqual({ deliveryPerformed: false, releaseMechanismVerified: false, custodyVerified: false, recipientConfirmed: false, missionExecuted: false, energyMarginQualified: false })
  expect(summary.counts.worldSnapshots).toBe(5001)
  expect(summary.counts.policyRows).toBe(1001)
  expect(summary.separation).toEqual({ scheduledAtMs: null, attemptedAtMs: null, outcome: 'not-requested', reason: null, beforeProperties: null, afterProperties: null })
  // The retained first centered result on pinned 1.4.2 exposes this raw maximum, without clamping it to 40.
  expect(summary.metrics.maxCommandSlewNPerS).toBe(40.000000000000014)
  expect(summary.final.authorityState).toBe('autonomous')
  expect(summary.final.boardMotorsN.some((n: number) => n > 0)).toBe(true)
  expect(summary.final.boardExpiresAtMs).toBeGreaterThan(20000)
  expect(summary.final.loadPhase).toBe('attached')
  expect(summary.final.experimentEnded).toBe(true)
  expect(summary.final.landingPerformed).toBe(false)
  expect(result.stdout.endsWith('\n')).toBe(true)
  expect(result.stdout.trim().split('\n').length).toBe(1)
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384)
}, 40000)


test('native cargo summaries preserve nominal separation and unqualified link-loss exits', async () => {
  for (const scenario of ['forward-carried', 'forward-separated', 'link-loss']) {
    const result = await command(['cargo:load-bench', '--scenario', scenario]).withTimeout(30000)
    expect(result.exitCode).toBe(scenario === 'link-loss' ? 1 : 0)
    expect(result.timedOut).toBe(false)
    const summary = JSON.parse(result.stdout)
    expect(summary.scenario).toBe(scenario)
    expect(summary.status).toBe(scenario === 'link-loss' ? 'unqualified' : 'characterized')
    expect(summary.reason).toBe(scenario === 'link-loss' ? 'cargo-load-authority-lost' : null)
    expect(summary.metrics.faultCharacterizationPassed).toBeUndefined()
    expect(summary.metrics.firstAuthorityLossAtMs).toBe(scenario === 'link-loss' ? 3000 : null)
    expect(summary.separation.outcome).toBe(scenario === 'forward-separated' ? 'separated' : scenario === 'link-loss' ? 'refused' : 'not-requested')
    expect(summary.separation.reason).toBe(scenario === 'forward-separated' ? 'prescribed-zero-ejection' : scenario === 'link-loss' ? 'authority-not-current' : null)
    expect(summary.final.loadPhase).toBe(scenario === 'forward-separated' ? 'separated' : 'attached')
    expect(summary.final.landingPerformed).toBe(false)
    expect(summary.capabilities.deliveryPerformed).toBe(false)
    expect(summary.capabilities.releaseMechanismVerified).toBe(false)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384)
  }
}, 100000)

test('native cargo final scenario values refuse coercion and caller details remain private', async () => {
  const sentinel = '/private-cargo-scenario-sentinel'
  for (const flags of [['--scenario', sentinel], ['--scenario', ''], ['--scenario=false'], ['--scenario', 'centered-carried', '--scenario', 'centered-carried']]) {
    const result = await command(['cargo:load-bench', ...flags]).withTimeout(30000)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Cargo load characterization failed: invalid input, unavailable result or output failure\n')
    expect(result.stderr).not.toContain(sentinel)
    expect(result.timedOut).toBe(false)
  }
  for (const flags of [['--scenario'], ['--unknown-cargo-flag'], ['--no-scenario']]) {
    const result = await command(['cargo:load-bench', ...flags]).withTimeout(30000)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain('owned-airborne-cargo-load-characterization')
    expect(result.timedOut).toBe(false)
  }
}, 100000)

test('drone bin registers the same native cargo command and keeps fault exit semantics', async () => {
  for (const [scenario, code] of [['forward-separated', 0], ['link-loss', 1]] as const) {
    const result = await cargoBin(['cargo:load-bench', '--scenario', scenario])
    expect(result.code).toBe(code)
    expect(result.timedOut).toBe(false)
    expect(result.overBudget).toBe(false)
    const summary = JSON.parse(result.stdout)
    expect(summary.scenario).toBe(scenario)
    expect(summary.status).toBe(code === 0 ? 'characterized' : 'unqualified')
    expect(summary.physicalFlightEnabled).toBe(false)
    expect(summary.boardOutputsInhibited).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384)
  }
}, 70000)

test('actual closed cargo stdout fails with the fixed awaited generic stderr and no success payload', async () => {
  const result = await cargoBin(['cargo:load-bench'], true)
  expect(result.timedOut).toBe(false)
  expect(result.overBudget).toBe(false)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('Cargo load characterization failed: invalid input, unavailable result or output failure\n')
}, 40000)

async function cargoBin(args: string[], closeStdout = false) {
  const child = spawn(process.execPath, ['bin/drone.ts', ...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false, overBudget = false
  if (closeStdout) child.stdout.destroy()
  else child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (Buffer.byteLength(stdout) > 32768) { overBudget = true; child.kill('SIGKILL') } })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); if (Buffer.byteLength(stderr) > 8192) { overBudget = true; child.kill('SIGKILL') } })
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30000)
  let code: number | null
  try { code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }) }
  finally { clearTimeout(guard) }
  return { code, stdout, stderr, timedOut, overBudget }
}
