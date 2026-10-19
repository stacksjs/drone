import type { ApplicationReport } from './types'
import { rasterPreviewDataUri } from '../presentation/raster'

/** Actual retained cell doses on a caller-declared fixed scale. Grey is missing or excluded support. */
export function applicationReportPreview(report: ApplicationReport, maximumDosePerHa: number): string {
  if (!Number.isFinite(maximumDosePerHa) || maximumDosePerHa <= 0) throw new RangeError('Invalid application display scale')
  const cells = report.cells
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > 512 || cells.some(c => !Array.isArray(c.boundsM) || c.boundsM.length !== 4 || !c.boundsM.every(Number.isFinite) || c.boundsM[0] >= c.boundsM[2] || c.boundsM[1] >= c.boundsM[3] || c.dosePerHa !== null && (!Number.isFinite(c.dosePerHa) || c.dosePerHa < 0))) throw new RangeError('Invalid application preview grid')
  const north = [...new Set(cells.map(c => c.boundsM[2]))].sort((a, b) => b - a)
  const east = [...new Set(cells.map(c => c.boundsM[1]))].sort((a, b) => a - b)
  if (north.length * east.length !== cells.length) throw new RangeError('Incomplete application preview grid')
  const pixels = new Uint8Array(cells.length * 4), occupied = new Set<number>()
  for (const cell of cells) {
    const index = north.indexOf(cell.boundsM[2]) * east.length + east.indexOf(cell.boundsM[1])
    if (occupied.has(index)) throw new RangeError('Duplicate application preview grid cell')
    occupied.add(index)
    const t = cell.dosePerHa === null ? null : Math.min(1, cell.dosePerHa / maximumDosePerHa)
    const colour = t === null ? [38, 38, 38, 255] : [Math.round(220 * (1 - t)), Math.round(40 + 180 * t), Math.round(55 + 30 * t), 255]
    pixels.set(colour, index * 4)
  }
  return rasterPreviewDataUri(east.length, north.length, pixels)
}
