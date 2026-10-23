import { expect, test } from 'bun:test'
import { createVtolTransitionProfile } from '../../resources/functions/drone/vehicles/vtol/transition-profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { airAerodynamics } from '../../resources/functions/drone/vehicles/air/plant'
import { vtolAerodynamics } from '../../resources/functions/drone/vehicles/vtol/plant'
import { quaternionFromTilt } from '../../resources/functions/drone/estimation/frames'
import { rotateNedToBody } from '../../resources/functions/drone/controls/physics'

// Agreed actual shared-runtime function seam: force-driven wind, raw IMU/GNSS, estimator,
// mission, controller and independent board leases. It does not qualify measured airframes.
test('the owned VTOL completes its finite route in a declared sustained 2 m/s tailwind', () => {
  const profile = createVtolTransitionProfile({ electrical: true })
  profile.faults = (_scenario, atMs) => ({ windMps: atMs >= 1000 ? [2, 0, 0] : [0, 0, 0] })
  const result = runVehicleSimulation(profile, { seconds: 160 })
  expect(result.status, JSON.stringify({ status: result.status, fault: result.fault, task: result.mission.taskId, reason: result.mission.reason })).toBe('completed')
  expect(result.mission.reason).toBe('landed')
  expect(result.path.at(-1)?.measurement?.values.onSurface).toBe(true)
  expect(result.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(result.board.expiresAtMs).toBeNull()
  expect(result.board.physicalActuationEnabled).toBe(false)
})

test('the fictional VTOL wing opposes small vertical motion in either chordwise flow direction', () => {
  for (const u of [-2, 2]) {
    const up = vtolAerodynamics([u, 0, -0.01], [0, 0, 0], [0, 0, 0, 0, 0])
    const down = vtolAerodynamics([u, 0, 0.01], [0, 0, 0], [0, 0, 0, 0, 0])
    expect(down.forceN[2] - up.forceN[2], `body U ${u}`).toBeLessThan(0)
    const pitched = rotateNedToBody(quaternionFromTilt(0, 0.01), [u, 0, 0])
    expect(vtolAerodynamics(pitched, [0, 0, 0], [0, 0, 0, 0, 0]).torqueNm[1], `body U ${u}`).toBeLessThan(0)
  }
})

test('the VTOL extension preserves the declared forward pre-stall trainer curve exactly', () => {
  for (const alpha of [-0.28, -0.1, 0, 0.1, 0.28]) {
    const relative: [number, number, number] = [13 * Math.cos(alpha), 0, 13 * Math.sin(alpha)]
    expect(vtolAerodynamics(relative, [0.01, -0.02, 0.03], [0.2, 0.1, -0.1, 0.2, 0])).toEqual(airAerodynamics(relative, [0.01, -0.02, 0.03], [0.2, 0.1, -0.1, 0.2, 0]))
  }
})

test('the VTOL folded-incidence curve has continuous force and pitch moment across reverse-flow angle wrapping', () => {
  for (const speed of [2, 8]) {
    const above = airAerodynamics([-speed, 0, 1e-8], [0, 0, 0], [0, 0, 0, 0, 0], true)
    const below = airAerodynamics([-speed, 0, -1e-8], [0, 0, 0], [0, 0, 0, 0, 0], true)
    expect(Math.hypot(...above.forceN.map((n, i) => n - below.forceN[i]!))).toBeLessThan(1e-5)
    expect(Math.hypot(...above.torqueNm.map((n, i) => n - below.torqueNm[i]!))).toBeLessThan(1e-5)
    expect(above.alphaRad).toBeGreaterThan(3)
    expect(below.alphaRad).toBeLessThan(-3)
  }
})
