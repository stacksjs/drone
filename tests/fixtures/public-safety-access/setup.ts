import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { cp, lstat, mkdir, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export async function setupIncidentDatabase(options: { prepare?: (root: string) => Promise<void>, prepareMigrations?: (root: string) => Promise<void> } = {}) {
  const root = process.cwd(), source = resolve(import.meta.dir, '../../..')
  assert(basename(root).startsWith('drone-incident-access-'))
  assert.equal(join(realpathSync(dirname(process.env.DB_DATABASE_PATH!)), basename(process.env.DB_DATABASE_PATH!)), join(root, 'access.sqlite'))
  await mkdir(join(root, 'app/Models'), { recursive: true })
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'storage/framework/database'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module","private":true}')
  await writeFile(join(root, 'config/database.ts'), "export default {default:'sqlite',models:{includeFrameworkDefaults:false},connections:{sqlite:{database:process.env.DB_DATABASE_PATH}},queryLogging:{enabled:false}}")
  if (!await lstat(join(root, 'node_modules')).catch(() => null)) await symlink(join(source, 'node_modules'), join(root, 'node_modules'))
  if (!await lstat(join(root, 'storage/framework/defaults')).catch(() => null)) await symlink(join(source, 'storage/framework/defaults'), join(root, 'storage/framework/defaults'))
  // Only owned model definitions and immutable migration sources are copied, never application DB files.
  await cp(join(source, 'app/Models'), join(root, 'app/Models'), { recursive: true })
  await options.prepare?.(root)
  await mkdir(join(root, 'resources/functions/drone/public-safety/access'), { recursive: true })
  await cp(join(source, 'resources/functions/drone/public-safety/access/types.ts'), join(root, 'resources/functions/drone/public-safety/access/types.ts'))
  await cp(join(source, 'resources/functions/drone/public-safety/access/record-types.ts'), join(root, 'resources/functions/drone/public-safety/access/record-types.ts'))
  await cp(join(source, 'database/migrations'), join(root, 'database/migrations'), { recursive: true })
  await cp(join(source, 'storage/framework/database/model-snapshot.sqlite.json'), join(root, 'storage/framework/database/model-snapshot.sqlite.json'))
  await options.prepareMigrations?.(root)
  const { overridesReady } = await import('@stacksjs/config')
  await overridesReady
  const database = await import('@stacksjs/database')
  await database.ensureDatabaseConfigLoaded()
  database.initializeDbConfig({ app: { env: 'test' }, database: { default: 'sqlite', connections: { sqlite: { database: process.env.DB_DATABASE_PATH } }, queryLogging: { enabled: false } } })
  assert.equal((await database.migrateAuthTables()).success, true)
  const migrated = await database.runDatabaseMigration()
  if (migrated.isErr) throw migrated.error
  assert.equal((await database.migrateAuthTables()).success, true)
  assert.equal((await database.migrateRbacTables()).success, true)
  const { ormReady } = await import('@stacksjs/orm')
  await ormReady
  const User = (await import(join(root, 'app/Models/User.ts'))).default
  return { root, database, User }
}
