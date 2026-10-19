import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Public functions with native Auth/SQLite/files catch lifecycle/byte regressions, not hardware power loss.
test('native managed dataset commits ownership before source-derived bytes and reconciles read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-'))
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS actual native managed source-derived dataset publication')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)

// Real native query instrumentation observes persisted effects without replacing a dependency.
test('native managed fences refuse reset, late expiry and revocation and retain SQL failure outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-critical-'))
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-critical.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS actual B critical fences, expiry, SQL rollback, late read authorization and CAS')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)

// Native connection retirement is terminal for each fixture process, not a garbage-collection availability promise.
test('actual managed prepare and publish nonce fences refuse native close and reset', async () => {
  for (const phase of ['prepared-close', 'prepared-reset', 'complete-close', 'complete-reset']) {
    const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-retirement-'))
    try {
      const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
      const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-critical.ts`, phase], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, `${phase}\n${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS actual B ${phase.replace('-', ' ')} refuses late synchronous filesystem stage`)
    }
    finally { await rm(root, { recursive: true, force: true }) }
  }
}, 180000)

// Actual process death and fresh native recovery catch SQL/FS ambiguity; they do not emulate power loss.
test('managed attempts survive process death without recreating a lost writer', async () => {
  for (const stage of ['intent-committed', 'zero-before-commit', 'ownership-committed', 'complete-before-commit', 'lost-response']) {
    const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-process-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
      const args = [process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-process.ts`]
      const options = { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe' as const, stderr: 'pipe' as const }
      const running = Bun.spawn([...args, 'create', stage], options)
      child = running
      const output = new Response(running.stdout).text(), errors = new Response(running.stderr).text()
      const deadline = Date.now() + 60000
      while (!await Bun.file(join(root, 'managed-pause.json')).exists() && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      if (!await Bun.file(join(root, 'managed-pause.json')).exists()) {
        child.kill('SIGKILL'); await child.exited
        throw new Error(`${stage} did not reach the actual barrier\n${await output}\n${await errors}`)
      }
      child.kill('SIGKILL'); await child.exited; await Promise.all([output, errors])
      const recovery = Bun.spawn([...args, 'recover', stage], options)
      const [code, stdout, stderr] = await Promise.all([recovery.exited, new Response(recovery.stdout).text(), new Response(recovery.stderr).text()])
      expect(code, `${stage}\n${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS real child kill ${stage}`)
    }
    finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
  }
}, 180000)

// The public native function seam catches access and real namespace drift, not a privileged hostile host.
test('managed native role matrix and binary integrity preserve unknown data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-matrix-'))
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-matrix.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS actual managed role/scope matrix')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)

// Real registered-inode mutations exercise partial/alias interpretation, not an observed crash window.
test('managed recovery classifies registered partial and manifest alias states without writes', async () => {
  for (const stage of ['partial-payload', 'pending-manifest', 'two-aliases']) {
    const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-alias-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
      const args = [process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-process.ts`]
      const options = { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe' as const, stderr: 'pipe' as const }
      const running = Bun.spawn([...args, 'create', stage], options)
      child = running
      const output = new Response(running.stdout).text(), errors = new Response(running.stderr).text()
      const deadline = Date.now() + 60000
      while (!await Bun.file(join(root, 'managed-pause.json')).exists() && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      if (!await Bun.file(join(root, 'managed-pause.json')).exists()) { child.kill('SIGKILL'); await child.exited; throw new Error(`${stage}\n${await output}\n${await errors}`) }
      child.kill('SIGKILL'); await child.exited; await Promise.all([output, errors])
      const recovery = Bun.spawn([...args, 'recover', stage], options)
      const [code, stdout, stderr] = await Promise.all([recovery.exited, new Response(recovery.stdout).text(), new Response(recovery.stderr).text()])
      expect(code, `${stage}\n${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS controlled registered-inode fixture ${stage}`)
    }
    finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
  }
}, 180000)

// Stopped real B transactions prove write-lock fencing, and committed public reconciliation invalidates a paused live handle.
test('managed real writer authority fences competing reconciliation in both filesystem phases', async () => {
  for (const stage of ['held-prepare', 'held-publish', 'generation-claim']) {
    const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-writer-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
      const args = [process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-process.ts`]
      const options = { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe' as const, stderr: 'pipe' as const }
      const running = Bun.spawn([...args, 'create', stage], options)
      child = running
      const output = new Response(running.stdout).text(), errors = new Response(running.stderr).text()
      const deadline = Date.now() + 60000
      while (!await Bun.file(join(root, 'managed-process.json')).exists() && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      if (!await Bun.file(join(root, 'managed-process.json')).exists()) { child.kill('SIGKILL'); await child.exited; throw new Error(`${stage}\n${await output}\n${await errors}`) }
      const contender = Bun.spawn([...args, 'contend', stage], { ...options, env: { ...options.env, MANAGED_REUSE_DATABASE: '1' } })
      const [contenderCode, contenderOut, contenderError] = await Promise.all([contender.exited, new Response(contender.stdout).text(), new Response(contender.stderr).text()])
      expect(contenderCode, `${stage}\n${contenderOut}\n${contenderError}`).toBe(0)
      expect(contenderOut).toContain(stage === 'generation-claim' ? 'PASS real public reconciliation commits new generation' : `PASS real public reconciler cannot write during ${stage}`)
      child.kill('SIGCONT')
      expect(await child.exited, `${stage}\n${await output}\n${await errors}`).toBe(0)
      expect(await output).toContain(stage === 'generation-claim' ? 'PASS paused original live handle refuses committed reconciliation generation' : `PASS ${stage} completes after competing writer refusal`)
    }
    finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
  }
}, 180000)

// The native migration seam proves a real old source DB upgrade and repeated generator no-op.
test('managed generated migrations preserve existing incident evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-upgrade-'))
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-migration.ts`], { cwd: root, env: { ...process.env, MANAGED_OLD_SCHEMA: '1', APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS managed generated schema upgrade preserves actual old source')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)

// Real source-derived history crosses both page limits and preserves the original custody acceptance.
test('managed native history pages beyond one hundred artifacts and events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-pages-'))
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-pages.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS actual101managed artifacts and105events paginate without source replay')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 600000)

// Actual wall time and native auth catch expired held content, without a clock replacement.
test('managed held expiry exposes only minimized custody aggregates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-expiry-'))
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-expiry.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS real wall-clock held expiry denies all managed content')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)
