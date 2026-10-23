import { expect, test } from 'bun:test'
import { createVtolTransitionProfile } from '../../resources/functions/drone/vehicles/vtol/transition-profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'
import type { SensorVector } from '../../resources/functions/drone/sensors/types'

const winds = [
  { name: 'head', vector: [-2, 0, 0], heading: 0 },
  { name: 'tail', vector: [2, 0, 0], heading: 0 },
  { name: 'east', vector: [0, 2, 0], heading: -Math.PI / 2 },
  { name: 'west', vector: [0, -2, 0], heading: Math.PI / 2 },
] as const
const phases = [{ name: 'front', task: 'front' }, { name: 'cruise', task: 'cruise-leg' }, { name: 'back', task: 'back' }, { name: 'landing', task: 'land' }] as const

// Actual-runtime seam. The external weather step follows an observed public
// mission phase, never a guessed timestamp or a controller wind input.
for (const wind of winds) for (const phase of phases) test(`${wind.name} wind begins at the actual ${phase.name} phase and completes the declared heading plan`, () => {
  const profile = createVtolTransitionProfile({ electrical: true }), factory = profile.createSession
  const vector: SensorVector = [...wind.vector]
  const back = profile.mission.tasks.find(task => task.id === 'back')
  if (!back || back.kind !== 'vtol-mode') throw new Error('Missing back heading')
  back.headingRad = wind.heading
  let onset: number | null = null, enteredAt: number | null = null, firstApplied: number | null = null, applied = false
  profile.faults = (_scenario, atMs) => ({ windMps: onset !== null && atMs >= onset ? vector : [0, 0, 0] })
  profile.createSession = () => {
    const session = factory()
    return { ...session, createController() {
      const controller = session.createController()
      return { step(context) {
        if (onset === null && context.enabled && context.mission.state === 'running' && context.mission.taskId === phase.task) { enteredAt = context.nowMs; onset = context.nowMs + 4 }
        return controller.step(context)
      } }
    }, createPlant() {
      const plant = session.createPlant()
      return { snapshot: () => plant.snapshot(), step(actuators, dtS, world) {
        const state = plant.step(actuators, dtS, world)
        applied = world.windMps.every((value, i) => value === vector[i])
        return state
      } }
    }, observeIndependent(state, atMs, actuators, hostAvailable) {
      session.observeIndependent?.(state, atMs, actuators, hostAvailable)
      if (applied && firstApplied === null) firstApplied = atMs
    } }
  }
  const result = runVehicleSimulation(profile, { seconds: 160 })
  expect(enteredAt).not.toBeNull()
  expect(onset).toBe(enteredAt! + 4)
  expect(firstApplied).toBe(onset)
  expect(result.status).toBe('completed')
  expect(result.fault).toBeNull()
  expect(result.budget).toEqual({ worstCaseMs: 131520, requiredWh: 43.84 })
  const confirmations = result.trace.rows.flatMap(row => row.observation.transition?.outcome === 'confirmed' ? [row.observation.transition] : [])
  expect(confirmations.map(row => [row.taskId, row.phase])).toEqual([['initial-hover', 'hover'], ['front', 'cruise'], ['back', 'hover']])
  expect(result.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(result.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(result.board.expiresAtMs).toBeNull()
  expect(result.board.physicalActuationEnabled).toBe(false)
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
})
