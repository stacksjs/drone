import type { InspectionCapture } from './types'
import { rasterPreviewDataUri } from '../presentation/raster'

/** Browser preview of actual recorded pixels. Thermal colours use one fixed synthetic 20..40 C scale. */
export function inspectionImagePreview(capture: Pick<InspectionCapture, 'image'>, modality: 'visible' | 'thermal'): string {
  const { width, height, rgba, thermalCentiKelvin } = capture.image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 65536 || !(rgba instanceof Uint8Array) || rgba.length !== width * height * 4 || !(thermalCentiKelvin instanceof Uint16Array) || thermalCentiKelvin.length !== width * height || !['visible', 'thermal'].includes(modality)) throw new RangeError('Invalid bounded inspection preview')
  if (modality === 'visible') return rasterPreviewDataUri(width, height, rgba)
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    const kelvin = thermalCentiKelvin[index]!
    if (kelvin === 0) { pixels.set([38, 38, 38, 255], index * 4); continue }
    const t = Math.max(0, Math.min(1, (kelvin - 29315) / 2000))
    pixels.set([Math.round(255 * t), Math.round(220 * (1 - Math.abs(2 * t - 1))), Math.round(255 * (1 - t)), 255], index * 4)
  }
  return rasterPreviewDataUri(width, height, pixels)
}
