import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const mode of ['source', 'bundles']) test(`native production execution bootstrap ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-execution-bootstrap-'))
  const source = resolve(import.meta.dir, '../..')
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    // Native preload runs before the fixture, so establish the guarded disposable
    // config/models/import layout first. Never preload against application DBs.
    await mkdir(join(root, 'app/Models'), { recursive: true })
    await mkdir(join(root, 'config'), { recursive: true })
    await mkdir(join(root, 'storage/framework'), { recursive: true })
    await mkdir(join(root, 'resources/functions/drone/public-safety/access'), { recursive: true })
    await symlink(join(source, 'node_modules'), join(root, 'node_modules'))
    await symlink(join(source, 'storage/framework/defaults'), join(root, 'storage/framework/defaults'))
    await cp(join(source, 'app/Models'), join(root, 'app/Models'), { recursive: true })
    for (const name of ['types.ts', 'record-types.ts']) await cp(join(source, `resources/functions/drone/public-safety/access/${name}`), join(root, `resources/functions/drone/public-safety/access/${name}`))
    await writeFile(join(root, 'package.json'), '{"type":"module","private":true}')
    await writeFile(join(root, 'config/database.ts'), "export default {default:'sqlite',models:{includeFrameworkDefaults:false},connections:{sqlite:{database:process.env.DB_DATABASE_PATH}},queryLogging:{enabled:false}}")
    const config = join(root, 'bunfig.toml')
    await writeFile(config, `preload=[${JSON.stringify(join(source, 'node_modules/@stacksjs/env/dist/plugin.js'))},${JSON.stringify(join(source, 'tests/fixtures/public-safety-access/execution-bootstrap-preload.ts'))}]\n[install]\nauto="disable"\n`)
    const entry = join(source, `tests/fixtures/public-safety-access/execution-bootstrap${mode === 'source' ? '' : '-bundles'}.ts`)
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', entry, mode], { cwd: root, env: { APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite'), DRONE_EXECUTION_BOOTSTRAP_MARKER: 'nonsecret-native-parent-marker' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 45000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      // eslint-disable-next-line no-console
      for (const line of stdout.split('\n')) if (line.startsWith('{"oracle":')) console.log(line)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(mode === 'source' ? 'PASS native production Worker with positive parent bootstrap' : 'PASS native independently bundled production owner and scope')
    }
    finally { if (running.exitCode === null) running.kill('SIGKILL'); await running.exited; clearTimeout(timeout) }
  }
  finally { if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}, 50000)
