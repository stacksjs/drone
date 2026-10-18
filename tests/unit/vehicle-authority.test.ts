import { expect, test } from 'bun:test'
import { createVehicleAuthoritySupervisor, createVehicleOutputWatchdog } from '../../resources/functions/drone/authority/vehicle'
import { observation } from '../fixtures/authority/context'
import type { VehicleActuator, VehicleControlOutput } from '../../resources/functions/drone/vehicles/types'
const actuators: VehicleActuator[] = [{ name: 'drive', unit: 'normalized', min: -1, max: 1, neutral: 0 }, { name: 'brake', unit: 'normalized', min: 0, max: 1, neutral: 1 }]
test('vehicle authority gates signed channels and independent expiry applies declared neutral brakes', () => {
  const options = { sessionId: 123n, bootId: 55n, vehicle: 'ground' as const, actuators, fence: { radiusM: 30, minDownM: -2, maxDownM: 1 } }
  const supervisor = createVehicleAuthoritySupervisor(options)
  function send(action: 'arm' | 'engage') { const s = supervisor.snapshot(); return supervisor.update(observation(), { version: 1, sessionId: 123n, bootId: 55n, epoch: s.epoch, sequence: s.sequence + 1, issuedAtMs: 1000, action, mode: 'position', target: { positionM: [0, 0, -1], yawRad: 0 }, leaseMs: 100 }) }
  expect(send('arm').state).toBe('armed-idle')
  expect(send('engage').state).toBe('autonomous')
  const output: VehicleControlOutput = { kind: 'simulated-vehicle-control', vehicle: 'ground', atMs: 1000, actuators: [-0.4, 0], inhibited: false, reason: 'test', physicalFlightEnabled: false, boardOutputsInhibited: true }
  const frame = supervisor.gate(output, 1000)!
  expect(frame.actuators).toEqual([-0.4, 0])
  const board = createVehicleOutputWatchdog(options)
  expect(board.accept(frame, 1000)).toBe(true)
  output.actuators[0] = 100
  expect(board.tick(1059).actuators).toEqual([-0.4, 0])
  expect(board.tick(1060).actuators).toEqual([0, 1])
  expect(board.snapshot().fault).toBe('output-lease-expired')
  expect(board.accept(frame, 1060)).toBe(false)
})
