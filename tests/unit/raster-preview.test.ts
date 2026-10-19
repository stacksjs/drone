import { expect, test } from 'bun:test'
import { rasterPreviewDataUri } from '../../resources/functions/drone/presentation/raster'

test('bounded raster previews preserve opaque and transparent source pixels with exact row runs', () => {
  const source = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 128])
  const svg = decodeURIComponent(rasterPreviewDataUri(3, 1, source))
  expect(svg).toContain('fill="#ff0000" d="M0 0h2v1H0z"')
  expect(svg).toContain('fill="#0000ff80" d="M2 0h1v1H2z"')
  expect(() => rasterPreviewDataUri(0, 1, source)).toThrow()
  expect(() => rasterPreviewDataUri(3, 2, source)).toThrow()
  expect(() => rasterPreviewDataUri(65537, 1, new Uint8Array(65537 * 4))).toThrow()
})
