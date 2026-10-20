import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { cp, lstat, mkdir, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export async function setupPatrolDatabase(options: { prepare?: (root: string) => Promise<void>, prepareMigrations?: (root: string) => Promise<void>, reuseDatabase?: boolean } = {}) {
  const root = process.cwd(), source = resolve(import.meta.dir, '../../..')
  assert(basename(root).startsWith('drone-patrol-review-'))
  assert.equal(join(realpathSync(dirname(process.env.DB_DATABASE_PATH!)), basename(process.env.DB_DATABASE_PATH!)), join(root, 'review.sqlite'))
  let currentPhase = 'tree-preparation'
  const phase = (value: 'tree-prepared' | 'config-ready' | 'database-import-ready' | 'database-config-ready' | 'migrations-ready' | 'orm-ready' | 'user-model-ready') => {
    currentPhase = value
    // Literal fixture stages only, never credentials, model contents or arbitrary errors.
    // eslint-disable-next-line no-console
    if (process.env.PATROL_QUALIFICATION === 'race-quota') console.log(JSON.stringify({ label: 'native-patrol-setup-phase', phase: value }))
  }
  try {
    await mkdir(join(root, 'app/Models'), { recursive: true })
    await mkdir(join(root, 'config'), { recursive: true })
    await mkdir(join(root, 'app/Middleware'), { recursive: true })
    await writeFile(join(root, 'app/Middleware/PatrolAuth.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Middleware/PatrolAuth.ts'))}`)
    await mkdir(join(root, 'storage/framework/database'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"type":"module","private":true}')
    await writeFile(join(root, 'config/database.ts'), "export default {default:'sqlite',models:{includeFrameworkDefaults:false},connections:{sqlite:{database:process.env.DB_DATABASE_PATH}},queryLogging:{enabled:false}}")
    if (!await lstat(join(root, 'node_modules')).catch(() => null)) await symlink(join(source, 'node_modules'), join(root, 'node_modules'))
    if (!await lstat(join(root, 'storage/framework/defaults')).catch(() => null)) await symlink(join(source, 'storage/framework/defaults'), join(root, 'storage/framework/defaults'))
    // Application model/migration sources only; no existing database or credential file is copied.
    await cp(join(source, 'app/Models'), join(root, 'app/Models'), { recursive: true })
    await options.prepare?.(root)
    await mkdir(join(root, 'resources/functions/drone/public-safety/access'), { recursive: true })
    await cp(join(source, 'resources/functions/drone/public-safety/access/types.ts'), join(root, 'resources/functions/drone/public-safety/access/types.ts'))
    await cp(join(source, 'resources/functions/drone/public-safety/access/record-types.ts'), join(root, 'resources/functions/drone/public-safety/access/record-types.ts'))
    await cp(join(source, 'database/migrations'), join(root, 'database/migrations'), { recursive: true })
    await cp(join(source, 'storage/framework/database/model-snapshot.sqlite.json'), join(root, 'storage/framework/database/model-snapshot.sqlite.json'))
    await options.prepareMigrations?.(root)
    phase('tree-prepared')
    const { overridesReady } = await import('@stacksjs/config')
    await overridesReady
    phase('config-ready')
    const database = await import('@stacksjs/database')
    phase('database-import-ready')
    await database.ensureDatabaseConfigLoaded()
    database.initializeDbConfig({ app: { env: 'test' }, database: { default: 'sqlite', connections: { sqlite: { database: process.env.DB_DATABASE_PATH } }, queryLogging: { enabled: false } } })
    phase('database-config-ready')
    if (!options.reuseDatabase) {
      assert.equal((await database.migrateAuthTables()).success, true)
      const migrated = await database.runDatabaseMigration()
      if (migrated.isErr) throw migrated.error
      assert.equal((await database.migrateAuthTables()).success, true)
      assert.equal((await database.migrateRbacTables()).success, true)
    }
    else assert((await lstat(process.env.DB_DATABASE_PATH!)).isFile(), 'Reuse requires an existing guarded disposable database')
    phase('migrations-ready')
    const { ormReady } = await import('@stacksjs/orm')
    await ormReady
    phase('orm-ready')
    const User = (await import(join(root, 'app/Models/User.ts'))).default
    phase('user-model-ready')
    return { root, database, User }
  }
  catch (error) {
    // Retain the original error and exit. This record only locates the last completed setup boundary.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ label: 'native-patrol-setup-failure-phase', phase: currentPhase }))
    throw error
  }
}
