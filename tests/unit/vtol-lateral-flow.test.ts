import { expect, test } from 'bun:test'
import { vtolAerodynamics } from '../../resources/functions/drone/vehicles/vtol/plant'

// Public fictional-aerodynamics seam: force/moment continuity at finite lateral
// flow. This does not validate measured coefficients or a physical airframe.
test('VTOL forces are continuous across zero chordwise flow with finite spanwise airspeed', () => {
  const above = vtolAerodynamics([1e-8, 2, 0], [0, 0, 0], [0, 0, 0, 0, 0])
  const below = vtolAerodynamics([-1e-8, 2, 0], [0, 0, 0], [0, 0, 0, 0, 0])
  expect(Math.hypot(...above.forceN.map((value, i) => value - below.forceN[i]!))).toBeLessThan(1e-5)
})

test('force and static pitch converge to the lateral-flow limit from every longitudinal direction', () => {
  for (const v of [-2, 2]) {
    const center = vtolAerodynamics([0, v, 0], [0, 0, 0], [0, 0, 0, 0, 0])
    for (const [u, w] of [[1e-8, 0], [-1e-8, 0], [0, 1e-8], [0, -1e-8], [1e-8, 1e-8], [-1e-8, 1e-8], [1e-8, -1e-8], [-1e-8, -1e-8]]) {
      const next = vtolAerodynamics([u!, v, w!], [0, 0, 0], [0, 0, 0, 0, 0])
      expect(Math.hypot(...next.forceN.map((value, i) => value - center.forceN[i]!))).toBeLessThan(1e-5)
      expect(Math.hypot(...next.torqueNm.map((value, i) => value - center.torqueNm[i]!))).toBeLessThan(1e-5)
    }
  }
})

test('the projected unpowered model dissipates airflow energy through zero, lateral and reverse flow', () => {
  for (const u of [-13, -2, -1e-8, 0, 1e-8, 2, 13]) for (const v of [-2, 0, 2]) for (const w of [-2, 0, 2]) {
    const response = vtolAerodynamics([u, v, w], [0, 0, 0], [0, 0, 0, 0, 0])
    expect([...response.forceN, ...response.torqueNm].every(Number.isFinite)).toBe(true)
    expect(response.forceN[0] * u + response.forceN[1] * v + response.forceN[2] * w).toBeLessThanOrEqual(1e-8)
  }
  expect(vtolAerodynamics([0, 0, 0], [0, 0, 0], [0, 0, 0, 0, 0]).forceN).toEqual([0, -0, -0])
})
