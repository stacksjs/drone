import { expect, test } from 'bun:test'
import type { ApplicationReport } from '../../resources/functions/drone/application/types'
import { applicationReportPreview } from '../../resources/functions/drone/application/presentation'

// Independently authored north-up 2x2 dose grid. This verifies visual delivery of
// retained numeric cells, not spatial processing, physical dose or calibration.
test('application preview preserves north-up numeric dose and grey missing support on one declared scale', () => {
  const cell = (id: string, boundsM: [number, number, number, number], dose: number | null) => ({ id, boundsM, areaM2: 1, excludedAreaM2: 0, coveredAreaM2: dose === null ? 0 : 1, overlapAreaM2: 0, depositedAmount: dose === null ? 0 : dose / 10000, prescribedAmount: .02, dosePerHa: dose, prescriptionIds: ['zone'] })
  const report: ApplicationReport = { version: 1, unit: 'L', fieldAreaM2: 4, treatableAreaM2: 4, coveredAreaM2: 3, missedAreaM2: 1, overlapAreaM2: 0, emittedAmount: .06, inFieldAmount: .06, excludedAmount: 0, outsideAmount: 0, inFlightAmount: 0, conservationError: 0, cells: [cell('north-west', [1, 0, 2, 1], 0), cell('north-east', [1, 1, 2, 2], 100), cell('south-west', [0, 0, 1, 1], 200), cell('south-east', [0, 1, 1, 2], null)], coverageEvidence: 'modeled-deposition-truth', physicalApplicationVerified: false, limitations: [] }
  const svg = decodeURIComponent(applicationReportPreview(report, 200).split(',')[1]!)
  expect(svg).toContain('viewBox="0 0 2 2"')
  expect(svg).toContain('fill="#dc2837"')
  expect(svg).toContain('fill="#6e8246"')
  expect(svg).toContain('fill="#00dc55"')
  expect(svg).toContain('fill="#262626"')
  expect(svg.indexOf('#dc2837')).toBeLessThan(svg.indexOf('#00dc55'))
  const reversed = { ...report, cells: [...report.cells].reverse() }
  expect(applicationReportPreview(reversed, 200)).toBe(applicationReportPreview(report, 200))
  expect(() => applicationReportPreview(report, 0)).toThrow('scale')
  expect(() => applicationReportPreview({ ...report, cells: [report.cells[0]!, report.cells[0]!] }, 200)).toThrow('grid')
})
