import { randomUUID } from 'node:crypto'
import { enqueueAfterCommit } from '@stacksjs/database/runtime'
import { emit } from '@stacksjs/realtime/emit'
import { getServer } from '@stacksjs/realtime/server-instance'
import { getReplayBuffer } from '@stacksjs/realtime/replay-buffer'

const processChannel = randomUUID()
export function workspaceRefreshChannel(incidentId: number): string {
  if (!Number.isSafeInteger(incidentId) || incidentId < 1) throw new RangeError('Invalid workspace incident identity')
  return `incident-workspace.${processChannel}.${incidentId}`
}
/** Called inside the actual mutating transaction; no credential, SQL or private content is captured. */
export function queueIncidentWorkspaceRefresh(incidentId: number): void {
  const channel = workspaceRefreshChannel(incidentId)
  enqueueAfterCommit(() => {
    try {
      const buffered = getReplayBuffer()?.channels.some(pattern => pattern === '*' || pattern === channel || pattern.endsWith('.*') && channel.startsWith(pattern.slice(0, -1)))
      if (!buffered && getServer()) emit(channel, 'refresh', { refresh: true })
    }
    catch { /* A hint cannot change a committed outcome. Periodic reads repair missed delivery. */ }
  })
}
