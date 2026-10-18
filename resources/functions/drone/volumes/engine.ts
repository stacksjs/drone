import type { VolumePiece, VolumeReport, VolumeXY } from './types'
import { volumeBounds, volumeBoundsOverlap, volumeClipHalfPlane, volumeCross2D, volumeIntersectConvex, volumeSignedArea, volumeTriangulateRing } from './geometry'
import { validateVolumeRequest, volumeLimits } from './validation'
export * from './validation'

class Sum {
  value = 0
  private correction = 0
  add(value: number): void {
    const adjusted = value - this.correction, next = this.value + adjusted
    this.correction = (next - this.value) - adjusted; this.value = next
  }
}
interface Primitive { id: string, polygon: VolumeXY[], top: (p: VolumeXY) => number }
export function processStockpile(input: unknown): VolumeReport {
  const request = validateVolumeRequest(input), { surface, base } = request, anchor = request.boundary.outer[0]!
  const local = (p: VolumeXY): VolumeXY => [p[0] - anchor[0], p[1] - anchor[1]]
  const parts = [request.boundary.outer, ...request.boundary.holes].flatMap((ring, index) => volumeTriangulateRing(ring.map(local)).map((polygon, ear) => ({ polygon, bbox: volumeBounds(polygon), weight: (index === 0 ? 1 : -1) as 1 | -1, id: index === 0 ? `outer:${ear}` : `hole:${index - 1}:${ear}` })))
  const boundaryArea = new Sum()
  for (const part of parts) boundaryArea.add(part.weight * Math.abs(volumeSignedArea(part.polygon)))
  const primitives: Primitive[] = [], excludedGridCells: VolumeReport['excludedGridCells'] = []
  if (surface.geometry.kind === 'tin') {
    const g = surface.geometry
    for (let index = 0; index < g.triangles.length; index++) {
      const vertices = g.triangles[index]!.map(i => g.vertices[i]!), polygon = vertices.map(p => local([p[0], p[1]]))
      const a = polygon[0]!, b = polygon[1]!, c = polygon[2]!, z0 = vertices[0]![2], z1 = vertices[1]![2], z2 = vertices[2]![2], det = volumeCross2D(a, b, c)
      const east = ((z1 - z0) * (c[1] - a[1]) - (z2 - z0) * (b[1] - a[1])) / det
      const north = ((b[0] - a[0]) * (z2 - z0) - (c[0] - a[0]) * (z1 - z0)) / det
      primitives.push({ id: `triangle:${index}`, polygon, top: p => z0 + east * (p[0] - a[0]) + north * (p[1] - a[1]) })
    }
  }
  else {
    const g = surface.geometry
    for (let row = 0; row < g.height; row++) for (let column = 0; column < g.width; column++) {
      const elevation = g.rows[row]![column]!
      if (elevation === null) { excludedGridCells.push({ row, column }); continue }
      const x = g.westM + column * g.cellSizeM - anchor[0], y = g.southM + (g.height - row - 1) * g.cellSizeM - anchor[1], s = g.cellSizeM
      primitives.push({ id: `cell:${row}:${column}`, polygon: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]], top: () => elevation })
    }
  }
  const baseAtAnchor = base.anchorM[2] + base.gradientEast * (anchor[0] - base.anchorM[0]) + base.gradientNorth * (anchor[1] - base.anchorM[1])
  const covered = new Sum(), above = new Sum(), below = new Sum(), pieces: VolumePiece[] = []
  let candidates = 0
  for (const primitive of primitives) {
    const bbox = volumeBounds(primitive.polygon), difference = (p: VolumeXY) => primitive.top(p) - baseAtAnchor - base.gradientEast * p[0] - base.gradientNorth * p[1]
    for (const part of parts) {
      if (++candidates > volumeLimits.clippingCandidates) throw new Error('Volume clipping candidate budget exceeded; tile the surface or simplify the boundary')
      if (!volumeBoundsOverlap(bbox, part.bbox)) continue
      const intersection = volumeIntersectConvex(primitive.polygon, part.polygon)
      if (intersection.length < 3 || Math.abs(volumeSignedArea(intersection)) < 1e-12) continue
      // Zero-height polygons must appear once, and crossings are split BEFORE affine integration.
      const values = intersection.map(difference)
      const min = Math.min(...values), max = Math.max(...values)
      const split = min >= 0 || max <= 0 ? [intersection] : [volumeClipHalfPlane(intersection, difference), volumeClipHalfPlane(intersection, p => -difference(p))]
      for (const polygon of split) {
        if (polygon.length < 3) continue
        const area = Math.abs(volumeSignedArea(polygon))
        if (area < 1e-12) continue
        const integral = new Sum(), first = polygon[0]!
        for (let i = 1; i + 1 < polygon.length; i++) {
          const b = polygon[i]!, c = polygon[i + 1]!
          integral.add(Math.abs(volumeCross2D(first, b, c)) / 2 * (difference(first) + difference(b) + difference(c)) / 3)
        }
        if (!Number.isFinite(integral.value)) throw new Error('Volume integration exceeded finite numeric bounds')
        const positive = Math.max(0, integral.value), negative = Math.max(0, -integral.value)
        covered.add(part.weight * area); above.add(part.weight * positive); below.add(part.weight * negative)
        pieces.push({ sourceId: primitive.id, boundaryPart: part.id, weight: part.weight, polygonM: polygon.map(p => [p[0] + anchor[0], p[1] + anchor[1]]), areaM2: area, aboveBaseM3: positive, belowBaseM3: negative, signedTopMinusBaseM3: integral.value })
        if (pieces.length > volumeLimits.integrationPieces) throw new Error('Volume integration piece budget exceeded; tile the request')
      }
    }
  }
  const tolerance = Math.max(1e-8, boundaryArea.value * 1e-10), coveredAreaM2 = Math.min(boundaryArea.value, Math.max(0, covered.value))
  if (covered.value > boundaryArea.value + tolerance || covered.value < -tolerance || above.value < -tolerance || below.value < -tolerance) throw new Error('Volume geometry accounting failed; unresolved overlapping coverage')
  if (coveredAreaM2 < tolerance) throw new Error('Volume surface has no positive-area coverage inside the boundary')
  const uncoveredAreaM2 = Math.max(0, boundaryArea.value - coveredAreaM2), partial = uncoveredAreaM2 > tolerance
  const aboveBaseM3 = Math.max(0, above.value), belowBaseM3 = Math.max(0, below.value), signed = aboveBaseM3 - belowBaseM3
  const topBound = surface.metadata.provenance.georeferencing.verticalBoundM
  const conditionalBound = topBound !== null && base.verticalBoundM !== null ? coveredAreaM2 * (topBound + base.verticalBoundM) : null
  const comparison: VolumeReport['comparison'] = { status: 'unavailable', aboveDifferenceM3: null, belowDifferenceM3: null, signedDifferenceM3: null, relativeSignedDifference: null, combinedDeclaredBoundM3: null, withinCombinedDeclaredBound: null }
  const warnings: string[] = []
  if (partial) warnings.push('Coverage gaps remain. Full-boundary volume is unknown; covered-domain volume is not scaled or interpolated.')
  if (conditionalBound === null) warnings.push('Top or base vertical error bound is unknown. Conditional vertical volume bound is unavailable.')
  if (request.reference) {
    const ref = request.reference
    if (partial) warnings.push('Full-boundary comparison is unavailable for partial covered-domain integration.')
    else {
      const refSigned = ref.aboveBaseM3 - ref.belowBaseM3, difference = signed - refSigned
      comparison.status = ref.independence === 'not-independent' ? 'not-independent' : ref.evidence === 'synthetic' || surface.metadata.provenance.evidence === 'synthetic' ? 'synthetic-comparison' : 'operator-declared-reference'
      comparison.aboveDifferenceM3 = aboveBaseM3 - ref.aboveBaseM3; comparison.belowDifferenceM3 = belowBaseM3 - ref.belowBaseM3; comparison.signedDifferenceM3 = difference
      comparison.relativeSignedDifference = refSigned === 0 ? null : difference / Math.abs(refSigned)
      comparison.combinedDeclaredBoundM3 = conditionalBound !== null && ref.volumeBoundM3 !== null ? conditionalBound + ref.volumeBoundM3 : null
      comparison.withinCombinedDeclaredBound = comparison.combinedDeclaredBoundM3 === null ? null : Math.abs(difference) <= comparison.combinedDeclaredBoundM3
      warnings.push('Reference identity, independence and survey accuracy are operator declarations; comparison does not verify physical accuracy.')
    }
  }
  return {
    version: 1, id: request.id, method: 'clipped-affine-surface-plane-v1', evidence: surface.metadata.provenance.evidence,
    physicalActuationEnabled: false, acquisitionPerformed: false, reconstructionPerformed: false, physicalAccuracyVerified: false,
    status: partial ? 'partial-coverage' : 'covered-domain', reference: surface.metadata.reference,
    boundaryAreaM2: boundaryArea.value, coveredAreaM2, uncoveredAreaM2, coverageFraction: coveredAreaM2 / boundaryArea.value,
    aboveBaseM3, belowBaseM3, signedTopMinusBaseM3: signed, fullBoundarySignedM3: partial ? null : signed,
    integrationPieces: pieces, excludedGridCells,
    uncertainty: { conditionalVerticalBoundM3: conditionalBound, overallAccuracyBoundM3: null, horizontalBoundM: surface.metadata.provenance.georeferencing.horizontalBoundM,
      assumptions: ['Conditional vertical bound assumes pointwise top and base error bounds hold everywhere on the covered domain.', 'Unknown correlation is handled additively. No square-root sample-count precision gain is applied.', 'Horizontal registration, boundary ambiguity, classification and unobserved basal geometry are not included in the conditional bound.'] },
    comparison, warnings,
    limitations: ['Inputs are declared 2.5D terrain surfaces in one metre CRS and vertical datum. No reprojection or datum conversion is performed.', 'TIN elevations are affine per triangle. Grid elevations are piecewise constant per cell. Integration is exact for these representations within floating-point resolution.', 'Boundary triangulation uses signed outer and hole contributions. Per-piece metrics are unweighted; apply each piece weight for domain totals.', 'Coverage accounting tolerance is max(1e-8 square metres, boundary area times 1e-10). No missing heights are invented.', 'No acquisition, point-cloud meshing, photogrammetric reconstruction, LiDAR calibration, field survey or physical accuracy certification is performed.'],
  }
}
