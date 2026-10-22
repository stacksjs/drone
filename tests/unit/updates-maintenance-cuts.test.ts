import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { qualifyMaintenanceInterruptions } from '../fixtures/updates/maintenance-interruptions'

test('actual maintenance process cuts retain unresolved predecessors and recover only the active successor', async () => {
  const evidence = process.env.RUNTIME_MAINTENANCE_EVIDENCE
  const root = evidence ? resolve(evidence) : await mkdtemp(join(tmpdir(), 'drone-maintenance-cuts-'))
  if (evidence) await mkdir(root, { mode: 0o700 })
  let completed = false
  try {
    const result = await qualifyMaintenanceInterruptions(join(root, 'campaign'))
    expect(result.cuts).toBe(3)
    expect(result.physicalDeploymentAllowed).toBe(false)
    completed = true
  }
  finally {
    if (completed && !evidence) await rm(root, { recursive: true, force: true })
    else console.log(`Maintenance process-cut campaign retained at ${root}`)
  }
}, 90000)
