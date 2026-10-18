import { expect, test } from 'bun:test'
import { getMissionWorkspaceDefinition, runMissionWorkspace } from '../../resources/functions/drone/vehicles/workspace'
test('common mission workspace exposes ground coverage and material tasks with recorded acknowledgements', () => {
  const coverage = getMissionWorkspaceDefinition('ground', 'nominal')
  expect(coverage.tasks.some(t => t.kind === 'payload' && t.operation === 'mower-enable')).toBe(true)
  const logistics = runMissionWorkspace('ground', 'logistics')
  expect(logistics.status).toBe('completed')
  expect(logistics.rows.some(row => row.payloadAck?.operation === 'material-drop' && row.payloadAck.outcome === 'confirmed')).toBe(true)
  expect(logistics.rows.at(-1)!.targetM).toBeNull()
  expect(logistics.physicalActuationEnabled).toBe(false)
  expect(() => getMissionWorkspaceDefinition('ground', 'physical')).toThrow()
}, 60000)

import { missionWorkspacePlot } from '../../resources/functions/drone/vehicles/workspace'

test('all profile definitions retain their own budgets, goals and caller-owned task arrays', () => {
  for (const profile of ['quadcopter', 'fixed-wing', 'ground', 'surface', 'subsea'] as const) {
    const definition = getMissionWorkspaceDefinition(profile)
    expect(definition.tasks.length).toBeGreaterThan(2)
    expect(definition.budget.requiredWh).toBeLessThanOrEqual(definition.budget.usableWh)
    expect(definition.tasks.some(t => t.targetM !== null)).toBe(true)
    definition.tasks[0]!.edges.push('caller-mutation')
    expect(getMissionWorkspaceDefinition(profile).tasks[0]!.edges).not.toContain('caller-mutation')
  }
  const ground = getMissionWorkspaceDefinition('ground', 'logistics')
  expect(ground.tasks.some(t => t.operation === 'material-drop' && t.containerId === 'tray-1')).toBe(true)
  expect(() => getMissionWorkspaceDefinition('unknown' as never)).toThrow()
})

test('version one recovery and branch behavior remain accessible without inventing camera acknowledgements', () => {
  const recovery = runMissionWorkspace('quadcopter', 'recovery')
  expect(recovery.status).toBe('completed')
  expect(recovery.rows.some(row => row.state === 'paused')).toBe(true)
  expect(recovery.rows.some(row => row.payloadAck !== null)).toBe(false)
  expect(recovery.payloads.every(p => p.evidence === 'simulated-event')).toBe(true)
  expect(() => JSON.stringify(recovery)).not.toThrow()
  expect('truthPositionM' in recovery.rows[0]!).toBe(false)
  const branch = runMissionWorkspace('quadcopter', 'branch-return')
  expect(branch.status).toBe('completed')
  expect(branch.rows.some(row => row.reason === 'battery-branch' && row.taskId === 'return')).toBe(true)
  expect(branch.physicalActuationEnabled).toBe(false)
}, 60000)

test('surface workspace keeps bottle-correlated acknowledgements and declared survey uncertainty', () => {
  const surface = runMissionWorkspace('surface')
  expect(surface.status).toBe('completed')
  const ack = surface.rows.find(row => row.payloadAck)?.payloadAck
  expect(ack?.operation).toBe('water-sample')
  expect(ack?.containerId).toBe('harbour-bottle-001')
  expect(ack?.correlated).toBe(true)
  expect(surface.survey!.count).toBeGreaterThan(100)
  expect(surface.survey!.maximumHorizontalSigmaM).toBeGreaterThanOrEqual(1)
  expect(surface.survey!.assumptions).toContain('no charting certification')
  expect(surface.rows.at(-1)!.targetM).toBeNull()
}, 60000)

test('host loss is a separate outcome with stale host snapshots and a neutral independent board', () => {
  const lost = runMissionWorkspace('fixed-wing', 'host-loss')
  expect(lost.status).toBe('host-lost')
  expect(lost.snapshotsStale).toBe(true)
  expect(lost.rows.at(-1)!.state).toBe('running')
  expect(lost.authorityState).toBe('autonomous')
  expect(lost.boardNeutral).toBe(true)
  expect(lost.boardFault).toBe('output-lease-expired')
}, 60000)

test('north-up plotting projects estimated north upward and east right on one square scale', () => {
  const definition = getMissionWorkspaceDefinition('ground')
  const plot = missionWorkspacePlot(definition, [
    { atMs: 600, state: 'running', taskId: 'a', reason: 'test', positionM: [0, 0, 0], velocityMps: [0, 0, 0], targetM: null, payloadRequest: null, payloadAck: null },
    { atMs: 620, state: 'running', taskId: 'a', reason: 'test', positionM: [2, 2, 0], velocityMps: [0, 0, 0], targetM: null, payloadRequest: null, payloadAck: null },
  ])
  const [first, second] = plot.estimated.split(' ').map(pair => pair.split(',').map(Number))
  expect(second![0]!).toBeGreaterThan(first![0]!)
  expect(second![1]!).toBeLessThan(first![1]!)
  expect(plot.current).not.toBeNull()
})


test('subsea workspace exposes pressure DVL provenance and capture-bound synthetic camera and sonar evidence', () => {
  const run = runMissionWorkspace('subsea')
  expect(run.status).toBe('completed')
  expect(run.definition.assumptions).toContain('GPS is absent underwater')
  expect(run.navigationEvidence!.observedSensors.gnss).toBe(0)
  expect(run.navigationEvidence!.observedSensors.imu).toBeGreaterThan(100)
  expect(run.navigationEvidence!.datum).toBe('LOCAL_WATER_SURFACE')
  const frame = run.inspection!.frames[0]!
  expect(frame.camera.format).toBe('pgm-p5')
  expect(frame.camera.pixels).toHaveLength(16)
  expect(frame.camera.bytes).toHaveLength(27)
  expect(frame.pose.capturedAtMs).toBe(frame.capturedAtMs)
  expect(frame.sonar.rangeM).toBeGreaterThan(3.5)
  expect(run.rows.some(row => row.payloadAck?.operation === 'inspection-capture' && row.payloadAck.correlated)).toBe(true)
  expect(run.boardNeutral).toBe(true)
  expect(run.rows.at(-1)!.targetM).toBeNull()
}, 60000)
