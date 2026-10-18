import type { InspectionCapture } from './types'

/** Browser preview of actual recorded pixels. Thermal colours use one fixed synthetic 20..40 C scale. */
export function inspectionImagePreview(capture: Pick<InspectionCapture, 'image'>, modality: 'visible' | 'thermal'): string {
  const { width, height, rgba, thermalCentiKelvin } = capture.image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 65536 || !(rgba instanceof Uint8Array) || rgba.length !== width * height * 4 || !(thermalCentiKelvin instanceof Uint16Array) || thermalCentiKelvin.length !== width * height || !['visible', 'thermal'].includes(modality)) throw new RangeError('Invalid bounded inspection preview')
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  function colour(index: number): string {
    if (modality === 'visible') return `#${hex(rgba[index * 4]!)}${hex(rgba[index * 4 + 1]!)}${hex(rgba[index * 4 + 2]!)}`
    const kelvin = thermalCentiKelvin[index]!
    if (kelvin === 0) return '#262626'
    const t = Math.max(0, Math.min(1, (kelvin - 29315) / 2000))
    return `#${hex(Math.round(255 * t))}${hex(Math.round(220 * (1 - Math.abs(2 * t - 1))))}${hex(Math.round(255 * (1 - t)))}`
  }
  const rows: string[] = []
  for (let y = 0; y < height; y++) {
    let start = 0, current = colour(y * width)
    for (let x = 1; x <= width; x++) {
      const next = x < width ? colour(y * width + x) : ''
      if (next !== current) {
        rows.push(`<path fill="${current}" d="M${start} ${y}h${x - start}v1H${start}z"/>`)
        start = x; current = next
      }
    }
  }
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${rows.join('')}</svg>`)}`
}
