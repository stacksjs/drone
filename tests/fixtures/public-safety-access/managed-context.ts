import { retainedPreview } from '../../helpers/public-safety-retained'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
export const { database, User, root } = await setupIncidentDatabase({ reuseDatabase: process.env.MANAGED_REUSE_DATABASE === '1', async prepareMigrations(directory) {
  if (process.env.MANAGED_OLD_SCHEMA !== '1') return
  await mkdir(join(directory, 'pending-managed-migrations'))
  for (const name of ['1789486698572-create-public_safety_managed_artifacts-table.sql', '1789486698573-create-public_safety_managed_artifact_events-table.sql', '1789486698574-create-public_safety_managed_artifact_files-table.sql']) await rename(join(directory, 'database/migrations', name), join(directory, 'pending-managed-migrations', name))
} })
process.env.PUBLIC_SAFETY_MANAGED_ROOT = join(root, 'managed-private')
await mkdir(process.env.PUBLIC_SAFETY_MANAGED_ROOT, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
export const managed = await import('../../../resources/functions/drone/public-safety/managed/service')
export const retention = await import('../../../resources/functions/drone/public-safety/retention/service')
export const access = await import('../../../resources/functions/drone/public-safety/access/service')
export const records = await import('../../../resources/functions/drone/public-safety/access/records')
const { publicSafetyManagedGate } = await import('../../../resources/functions/drone/public-safety/managed/policy')
const { publicSafetyRetentionGate } = await import('../../../resources/functions/drone/public-safety/retention/policy')
const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { incidentAbilities } = await import('../../../resources/functions/drone/public-safety/access/types')
const { managedAbilities } = await import('../../../resources/functions/drone/public-safety/managed/types')
const { Gate } = await import('@stacksjs/auth/gate')
export const { Rbac } = await import('@stacksjs/auth/rbac')
export const { createToken } = await import('@stacksjs/auth/tokens')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
for (const ability of ['read', 'manage', 'revoke'] as const) Gate.define(`public-safety:retention-${ability}`, (user, key) => publicSafetyRetentionGate(user, key, ability))
for (const ability of managedAbilities) Gate.define(`public-safety:managed-${ability}`, (user, key) => publicSafetyManagedGate(user, key, ability))
export const as = <T>(token: string, work: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), work)
export async function actor(label: string) {
  const user = await User.create({ name: label, email: `${label}@example.invalid`, password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) { if (!await Rbac.findPermission(permission, 'web')) await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(user.id, permission, 'web') }
  const token = await createToken(user.id, label, ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
  return { user, token }
}
export async function seed(key: string, lifetime = 86400000, raster?: number) {
  const config = examplePublicSafetyConfig(); config.id = key; config.retention.expiresAt = new Date(Date.now() + lifetime).toISOString()
  if (raster !== undefined) {
    const output = config.survey.calibration.output
    for (const point of config.survey.heldOut) { point.pixel[0] *= raster / output.width; point.pixel[1] *= raster / output.height }
    output.width = raster; output.height = raster
  }
  const run = simulatePublicSafety({ config, seconds: 10 })
  await access.createPublicSafetyIncident({ config })
  const source = await records.registerPublicSafetySource(key, { expectedVersion: 1, recording: run })
  const preview = retainedPreview(await retention.previewPublicSafetyRetention(key))
  await retention.enrollPublicSafetyRetention(key, { expectedVersion: 2, policyVersion: 'local-managed-v1', inventoryDigest: preview.inventoryDigest, requestId: randomUUID() })
  return { config, run, source: source.source, body: { expectedVersion: 3, expectedRetentionVersion: 1, sourceDigest: source.source.digest, datasetProfile: 'owned-public-safety-dataset-v1', requestId: randomUUID() } }
}
export const status = (code: number) => (error: unknown) => error instanceof access.PublicSafetyAccessError && error.status === code
