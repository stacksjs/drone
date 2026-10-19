/** A browser-safe preview of bounded RGBA bytes. No arbitrary SVG markup or URL is accepted. */
export function rasterPreviewDataUri(width: number, height: number, pixels: Uint8Array): string {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 65536 || !(pixels instanceof Uint8Array) || pixels.length !== width * height * 4 || (typeof SharedArrayBuffer !== 'undefined' && pixels.buffer instanceof SharedArrayBuffer)) throw new RangeError('Invalid bounded raster preview')
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  const colour = (index: number) => `#${hex(pixels[index * 4]!)}${hex(pixels[index * 4 + 1]!)}${hex(pixels[index * 4 + 2]!)}${pixels[index * 4 + 3] === 255 ? '' : hex(pixels[index * 4 + 3]!)}`
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
