import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createBqbRbacStore } from '@stacksjs/auth/rbac-store-bqb'
import { flushRbacCache } from '@stacksjs/auth/rbac'
import { createToken } from '@stacksjs/auth/tokens'
import { transaction } from '@stacksjs/orm'

export interface IncidentAccessProvision {
  userId: number
  mode: 'read' | 'coordinate'
  createIncidents: boolean
  minutes: number
  output: string
}
/** Local database-administrator operation. Never expose this function through HTTP or a browser barrel. */
export async function provisionIncidentAccess(input: IncidentAccessProvision) {
  if (!input || !Number.isSafeInteger(input.userId) || input.userId < 1 || !['read', 'coordinate'].includes(input.mode) || typeof input.createIncidents !== 'boolean' || (input.createIncidents && input.mode !== 'coordinate') || !Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 60 || typeof input.output !== 'string' || !input.output.trim()) throw new TypeError('Access requires a positive user ID, read or coordinate mode, 1..60 minutes and a new output directory; creation requires coordinate mode')
  const { userId, mode, createIncidents, minutes } = input
  const root = resolve(input.output), tokenPath = resolve(root, 'token.json')
  const scopes = mode === 'coordinate' ? ['public-safety:read', 'public-safety:coordinate'] : ['public-safety:read']
  const permissions = createIncidents ? ['public-safety:access', 'public-safety:create'] : ['public-safety:access']
  // Reserve exclusive private output before granting anything. Existing paths are never replaced.
  await mkdir(root, { mode: 0o700 })
  const directoryIdentity = await lstat(root)
  let published = false, fileIdentity: { dev: number, ino: number } | undefined
  try {
    const file = await open(tokenPath, 'wx', 0o600)
    try {
      fileIdentity = await file.stat()
      const result = await transaction(async tx => {
        const user = await tx.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()
        if (!user) throw new TypeError('Native user does not exist')
        const store = createBqbRbacStore()
        for (const name of permissions) {
          const permission = await store.findPermissionByName(name, 'web') ?? await store.createPermission(name, 'web')
          await store.assignPermissionToUser(userId, permission.id)
        }
        const minted = await createToken(userId, 'public-safety-operator', scopes, { expiresInMinutes: minutes, withRefreshToken: false })
        await file.writeFile(`${JSON.stringify({ userId, tokenType: 'Bearer', token: minted.plainTextToken, scopes, expiresInSeconds: minted.expiresIn })}\n`)
        await file.sync()
        return { userId, tokenId: minted.accessToken.id, scopes, grantedPermissions: permissions, expiresInSeconds: minted.expiresIn, tokenPath }
      })
      published = true
      flushRbacCache()
      return result
    }
    finally { await file.close() }
  }
  finally {
    if (!published) {
      const currentFile = await lstat(tokenPath).catch(() => null)
      if (fileIdentity && currentFile?.dev === fileIdentity.dev && currentFile.ino === fileIdentity.ino) await unlink(tokenPath).catch(() => {})
      const currentDirectory = await lstat(root).catch(() => null)
      if (currentDirectory?.dev === directoryIdentity.dev && currentDirectory.ino === directoryIdentity.ino) await rmdir(root).catch(() => {})
    }
  }
}
