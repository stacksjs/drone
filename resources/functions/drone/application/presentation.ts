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

/** Fixed 600x160 data coordinates. Missing measurements break the measured line. No rate is clipped. */
export function applicationRatePlot(rows: readonly { atMs: number, targetPerSecond: number, measuredPerSecond: number | null }[], maximumRatePerSecond: number): { targetPath: string, measuredPath: string } {
  if (!Number.isFinite(maximumRatePerSecond) || maximumRatePerSecond <= 0) throw new RangeError('Invalid application rate display scale')
  if (!Array.isArray(rows) || rows.length > 9001) throw new RangeError('Invalid application rate plot capacity')
  let previous = -1
  for (const row of rows) {
    if (!Number.isSafeInteger(row.atMs) || row.atMs < 0 || row.atMs <= previous) throw new RangeError('Invalid application rate epoch')
    if (!Number.isFinite(row.targetPerSecond) || row.targetPerSecond < 0 || row.measuredPerSecond !== null && (!Number.isFinite(row.measuredPerSecond) || row.measuredPerSecond < 0)) throw new RangeError('Invalid application rate value')
    previous = row.atMs
  }
  if (!rows.length) return { targetPath: '', measuredPath: '' }
  const start = rows[0]!.atMs, duration = rows.at(-1)!.atMs - start
  const number = (value: number) => Math.round(value * 1000) / 1000
  let targetPath = '', measuredPath = '', measuredPen = false
  for (const [index, row] of rows.entries()) {
    const x = number(10 + (duration ? (row.atMs - start) / duration * 580 : 0))
    const y = (rate: number) => number(150 - rate / maximumRatePerSecond * 140)
    targetPath += `${index ? 'L' : 'M'}${x} ${y(row.targetPerSecond)}`
    if (row.measuredPerSecond === null) measuredPen = false
    else { measuredPath += `${measuredPen ? 'L' : 'M'}${x} ${y(row.measuredPerSecond)}`; measuredPen = true }
  }
  return { targetPath, measuredPath }
}
