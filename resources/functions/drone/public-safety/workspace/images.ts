import type { SourceRead } from '../access/record-types'
import { rasterPreviewDataUri } from '../../presentation/raster'

export interface WorkspaceCapture {
  id: string
  width: number
  height: number
  rgba: number[]
  support: number[]
  temperatures: number[]
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source capture')
  return value as Record<string, unknown>
}
function plane(value: unknown, length: number, maximum: number): number[] {
  if (!Array.isArray(value) || value.length !== length || value.some(sample => !Number.isInteger(sample) || sample < 0 || sample > maximum)) throw new Error('Invalid source image plane')
  return value as number[]
}
/** Actual admitted source pixels only. Never infers searched area from imagery or counts. */
export function workspaceCaptures(source: SourceRead): WorkspaceCapture[] {
  const run = record(source.recording), survey = record(run.survey)
  if (run.evidence !== 'owned-public-safety-physics-simulation' || run.physicalFlightEnabled !== false || run.physicalThermalVerified !== false || run.identityAuthenticated !== false || !Array.isArray(survey.captures) || !Array.isArray(run.captures) || survey.captures.length > 512) throw new Error('Unsupported source evidence')
  return survey.captures.map((input, index) => {
    const visible = record(input), thermal = record((run.captures as unknown[])[index])
    const width = Number(visible.width), height = Number(visible.height), count = width * height
    if (typeof visible.id !== 'string' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || count > 65536 || thermal.width !== width || thermal.height !== height) throw new Error('Invalid source image size')
    const rgba = plane(visible.rgba, count * 4, 255), support = plane(thermal.support, count, 2), temperatures = plane(thermal.thermalCentiKelvin, count, 65535)
    return { id: visible.id, width, height, support, temperatures, rgba }
  })
}
export function workspaceCapturePreview(capture: WorkspaceCapture | null, modality: 'visible' | 'thermal'): string {
  if (!capture) return ''
  if (modality === 'visible') return rasterPreviewDataUri(capture.width, capture.height, Uint8Array.from(capture.rgba))
  const pixels = new Uint8Array(capture.width * capture.height * 4)
  for (let at = 0; at < capture.support.length; at++) {
    if (capture.support[at] !== 1 || !capture.temperatures[at]) { pixels.set([38, 38, 38, 255], at * 4); continue }
    const value = Math.max(0, Math.min(1, (capture.temperatures[at]! - 29315) / 2000))
    pixels.set([Math.round(255 * value), Math.round(220 * (1 - Math.abs(2 * value - 1))), Math.round(255 * (1 - value)), 255], at * 4)
  }
  return rasterPreviewDataUri(capture.width, capture.height, pixels)
}
export function workspacePixel(capture: WorkspaceCapture | null, x: number, y: number): string {
  if (!capture || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= capture.width || y >= capture.height) return 'No available pixel selected'
  const index = y * capture.width + x, support = capture.support[index]
  if (support === 2) return 'Privacy masked. No observation may use this pixel.'
  if (support !== 1) return 'Unknown or unobserved. No observation may use this pixel.'
  const value = capture.temperatures[index]
  return `Observed synthetic ground. ${value ? `${(value / 100 - 273.15).toFixed(2)} C synthetic` : 'Thermal sample unavailable'}. Physical radiometry is unqualified.`
}
