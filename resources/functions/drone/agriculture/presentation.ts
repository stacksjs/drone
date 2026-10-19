import type { AgricultureCalibratedImage, AgricultureCapture, AgricultureLayer } from './types'
import { rasterPreviewDataUri } from '../presentation/raster'

/** One fixed -1..1 index scale; grey is nodata. Colours do not classify crop health. */
function indexColour(value: number | null): [number, number, number, number] {
  if (value === null || !Number.isFinite(value)) return [38, 38, 38, 255]
  const t = Math.max(0, Math.min(1, (value + 1) / 2))
  return [Math.round(220 * (1 - t)), Math.round(40 + 180 * t), Math.round(55 + 60 * (1 - Math.abs(2 * t - 1))), 255]
}
export function agricultureImagePreview(capture: AgricultureCapture, image: AgricultureCalibratedImage, mode: 'visible' | 'ndvi'): string {
  const { width, height, rgba } = capture.image
  if (width !== image.width || height !== image.height || image.valid.length !== width * height || image.ndvi.length !== width * height || !['visible', 'ndvi'].includes(mode)) throw new RangeError('Invalid agriculture image preview')
  if (mode === 'visible') return rasterPreviewDataUri(width, height, rgba)
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) pixels.set(indexColour(image.valid[i] ? image.ndvi[i]! : null), i * 4)
  return rasterPreviewDataUri(width, height, pixels)
}
export function agricultureLayerPreview(layer: AgricultureLayer): string {
  const { rows, columns } = layer.grid
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows * columns > 4096 || layer.cells.length !== rows * columns) throw new RangeError('Invalid agriculture layer preview')
  const pixels = new Uint8Array(rows * columns * 4)
  for (let i = 0; i < layer.cells.length; i++) pixels.set(indexColour(layer.cells[i]!.ndvi), i * 4)
  return rasterPreviewDataUri(columns, rows, pixels)
}
