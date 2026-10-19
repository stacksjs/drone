import type { ApplicationConfig, ApplicationRelease, ApplicationReport } from './types'
import type { ApplicationRun } from './runtime-types'
import type { VolumeXY } from '../volumes/types'
import { volumeBounds, volumeBoundsOverlap, volumeClipHalfPlane, volumeCross2D, volumeIntersectConvex, volumeSignedArea, volumeTriangulateRing } from '../volumes/geometry'
import { validateApplicationConfig } from './planner'
import { validateApplicationRun } from './evidence'

export const applicationCoverageLimits = Object.freeze({ releases: 10001, cells: 512, pieces: 65536, operations: 12000000 })
const epsilon = 1e-12
interface Polygon { points: VolumeXY[], bounds: [number, number, number, number] }
function polygon(points: VolumeXY[]): Polygon | null { return points.length >= 3 && Math.abs(volumeSignedArea(points)) > epsilon ? { points, bounds: volumeBounds(points) } : null }
function releaseFields(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Invalid application release record')
  let count = 0
  for (const key in value) if (!fields.includes(key) || ++count > fields.length) throw new TypeError('Invalid application release fields')
  for (const key of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Application release accessors or missing fields') }
  if (count !== fields.length || Object.getOwnPropertyNames(value).length !== fields.length || Object.getOwnPropertySymbols(value).length) throw new TypeError('Unsupported application release fields')
}
function tuple(value: unknown, size: number): value is number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== size || Object.getOwnPropertyNames(value).length !== size + 1 || Object.getOwnPropertySymbols(value).length) return false
  for (let i = 0; i < size; i++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(i)); if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'number' || !Number.isFinite(descriptor.value) || Math.abs(descriptor.value) > 10000) return false }
  return true
}
/** Exact finite uniform-kernel audit of independently modeled emitted material. No host-estimate or sensor truth is inferred. */
export function processApplicationReleases(input: ApplicationConfig, source: readonly ApplicationRelease[], endAtMs: number): ApplicationReport {
  const config = validateApplicationConfig(input)
  if (!Number.isSafeInteger(endAtMs) || endAtMs < 0 || endAtMs > 200000 || !Array.isArray(source) || source.length > applicationCoverageLimits.releases) throw new RangeError('Application release duration or resource bound')
  if (Object.getPrototypeOf(source) !== Array.prototype || Object.getOwnPropertyNames(source).length !== source.length + 1 || Object.getOwnPropertySymbols(source).length) throw new TypeError('Invalid application release array')
  const releases: ApplicationRelease[] = []
  let previous = -1
  for (let i = 0; i < source.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(i))
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Application release array accessors or gaps')
    const release = descriptor.value as ApplicationRelease
    releaseFields(release, ['atMs', 'amount', 'positionM', 'yawRad', 'windMps', 'taskId', 'hostAvailable', 'positionEvidence'])
    if (!Number.isSafeInteger(release.atMs) || release.atMs < 0 || release.atMs <= previous || release.atMs > endAtMs || typeof release.amount !== 'number' || !Number.isFinite(release.amount) || release.amount < 0 || release.amount > 1000 || !tuple(release.positionM, 3) || !tuple(release.windMps, 2) || typeof release.yawRad !== 'number' || !Number.isFinite(release.yawRad) || Math.abs(release.yawRad) > 1000 || (release.taskId !== null && (typeof release.taskId !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(release.taskId))) || typeof release.hostAvailable !== 'boolean' || release.positionEvidence !== 'modeled-plant-truth') throw new TypeError('Invalid modeled application release quantities or scope')
    releases.push(structuredClone(release)); previous = release.atMs
  }
  let operations = 0, storedPieces = 0
  function operation() { if (++operations > applicationCoverageLimits.operations) throw new RangeError('Exact application geometry operation budget exhausted') }
  function intersect(a: Polygon, b: Polygon): Polygon | null {
    operation()
    return volumeBoundsOverlap(a.bounds, b.bounds) ? polygon(volumeIntersectConvex(a.points, b.points)) : null
  }
  function subtract(subject: Polygon, clip: Polygon): Polygon[] {
    operation()
    if (!volumeBoundsOverlap(subject.bounds, clip.bounds)) return [subject]
    const result: Polygon[] = [], orientation = volumeSignedArea(clip.points) >= 0 ? 1 : -1
    let inside: Polygon | null = subject
    for (let i = 0; i < clip.points.length && inside; i++) {
      const a = clip.points[i]!, b = clip.points[(i + 1) % clip.points.length]!
      const outside = polygon(volumeClipHalfPlane(inside.points, p => -orientation * volumeCross2D(a, b, p)))
      if (outside) result.push(outside)
      inside = polygon(volumeClipHalfPlane(inside.points, p => orientation * volumeCross2D(a, b, p)))
    }
    return result
  }
  function unionAdd(union: Polygon[], value: Polygon) {
    let pending = [value]
    for (const existing of union) {
      const next: Polygon[] = []
      for (const piece of pending) next.push(...subtract(piece, existing))
      pending = next
      if (!pending.length) break
      if (pending.length + storedPieces > applicationCoverageLimits.pieces) throw new RangeError('Exact application geometry fragment budget exhausted')
    }
    storedPieces += pending.length
    if (storedPieces > applicationCoverageLimits.pieces) throw new RangeError('Exact application geometry fragment budget exhausted')
    union.push(...pending)
  }
  const field = volumeTriangulateRing(config.boundary).map(points => polygon(points)!)
  const exclusions = config.exclusions.flatMap(ring => volumeTriangulateRing(ring).map(points => polygon(points)!))
  function support(value: Polygon) {
    let fieldArea = 0, excludedArea = 0
    for (const triangle of field) {
      const clipped = intersect(value, triangle)
      if (!clipped) continue
      fieldArea += Math.abs(volumeSignedArea(clipped.points))
      for (const excluded of exclusions) { const area = intersect(clipped, excluded); if (area) excludedArea += Math.abs(volumeSignedArea(area.points)) }
    }
    return { fieldArea, excludedArea, treatableArea: Math.max(0, fieldArea - excludedArea) }
  }
  const zones = config.prescription.map(zone => ({ zone, polygons: volumeTriangulateRing(zone.polygon).map(points => polygon(points)!) }))
  const [nMin, eMin, nMax, eMax] = volumeBounds(config.boundary), resolution = config.gridResolutionM
  const rows = Math.ceil((nMax - nMin) / resolution), columns = Math.ceil((eMax - eMin) / resolution)
  if (rows * columns > applicationCoverageLimits.cells) throw new RangeError('Application coverage exceeds 512 cells')
  const cells: { report: ApplicationReport['cells'][number], rectangle: Polygon, passes: Map<string, Polygon[]>, unknown: Polygon[] }[] = []
  let fieldAreaM2 = 0, treatableAreaM2 = 0
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const northMax = nMax - row * resolution, northMin = Math.max(nMin, northMax - resolution), eastMin = eMin + column * resolution, eastMax = Math.min(eMax, eastMin + resolution)
    const rectangle = polygon([[northMin, eastMin], [northMax, eastMin], [northMax, eastMax], [northMin, eastMax]])!, area = support(rectangle)
    let prescribedAmount = 0
    const prescriptionIds: string[] = []
    for (const zone of zones) {
      let zoneArea = 0
      for (const triangle of zone.polygons) { const clipped = intersect(rectangle, triangle); if (clipped) zoneArea += support(clipped).treatableArea }
      if (zoneArea > epsilon) { prescribedAmount += zoneArea * zone.zone.ratePerHa / 10000; prescriptionIds.push(zone.zone.id) }
    }
    cells.push({ rectangle, passes: new Map(), unknown: [], report: { id: `cell-${row}-${column}`, boundsM: [northMin, eastMin, northMax, eastMax], areaM2: area.fieldArea, excludedAreaM2: area.excludedArea, coveredAreaM2: 0, overlapAreaM2: 0, depositedAmount: 0, prescribedAmount, dosePerHa: null, prescriptionIds } })
    fieldAreaM2 += area.fieldArea; treatableAreaM2 += area.treatableArea
  }
  let emittedAmount = 0, inFieldAmount = 0, excludedAmount = 0, outsideAmount = 0, inFlightAmount = 0
  const kernelArea = config.implement.swathM * config.implement.footprintLengthM
  for (const release of releases) {
    emittedAmount += release.amount
    if (release.amount === 0) continue
    if (release.atMs + config.implement.fallTimeS * 1000 > endAtMs) { inFlightAmount += release.amount; continue }
    const north = release.positionM[0] + release.windMps[0] * config.implement.fallTimeS, east = release.positionM[1] + release.windMps[1] * config.implement.fallTimeS, cos = Math.cos(release.yawRad), sin = Math.sin(release.yawRad)
    const halfLength = config.implement.footprintLengthM / 2, halfWidth = config.implement.swathM / 2
    const kernel = polygon(([[-halfLength, -halfWidth], [halfLength, -halfWidth], [halfLength, halfWidth], [-halfLength, halfWidth]] as VolumeXY[]).map(([along, across]) => [north + along * cos - across * sin, east + along * sin + across * cos]))!
    const area = support(kernel), density = release.amount / kernelArea
    inFieldAmount += density * area.treatableArea; excludedAmount += density * area.excludedArea; outsideAmount += density * Math.max(0, kernelArea - area.fieldArea)
    for (const cell of cells) {
      const clipped = intersect(kernel, cell.rectangle)
      if (!clipped) continue
      cell.report.depositedAmount += density * support(clipped).treatableArea
      if (release.taskId?.startsWith('apply-')) {
        const pass = cell.passes.get(release.taskId) ?? []
        unionAdd(pass, clipped); cell.passes.set(release.taskId, pass)
      }
      else unionAdd(cell.unknown, clipped)
    }
  }
  let coveredAreaM2 = 0, overlapAreaM2 = 0
  for (const cell of cells) {
    const union: Polygon[] = [], overlap: Polygon[] = []
    for (const pass of cell.passes.values()) for (const piece of pass) {
      for (const previousPiece of union) { const intersection = intersect(piece, previousPiece); if (intersection) unionAdd(overlap, intersection) }
      unionAdd(union, piece)
    }
    for (const piece of cell.unknown) unionAdd(union, piece)
    for (const piece of union) cell.report.coveredAreaM2 += support(piece).treatableArea
    for (const piece of overlap) cell.report.overlapAreaM2 += support(piece).treatableArea
    const treatable = Math.max(0, cell.report.areaM2 - cell.report.excludedAreaM2)
    if (treatable > epsilon) cell.report.dosePerHa = cell.report.depositedAmount * 10000 / treatable
    coveredAreaM2 += cell.report.coveredAreaM2; overlapAreaM2 += cell.report.overlapAreaM2
  }
  return { version: 1, unit: config.material.unit, fieldAreaM2, treatableAreaM2, coveredAreaM2, missedAreaM2: Math.max(0, treatableAreaM2 - coveredAreaM2), overlapAreaM2, emittedAmount, inFieldAmount, excludedAmount, outsideAmount, inFlightAmount, conservationError: emittedAmount - inFieldAmount - excludedAmount - outsideAmount - inFlightAmount, cells: cells.map(cell => cell.report), coverageEvidence: 'modeled-deposition-truth', physicalApplicationVerified: false,
    limitations: [
      'Uniform rectangular deposition kernels use independent modeled release pose and yaw, advected by declared wind times fixed fall time. No measured deposition, droplet/granule distribution, evaporation, turbulence or physical drift has been validated.',
      'Positive material still in transport at the audit epoch is in-flight. Treatable in-field, excluded and outside amounts remain disjoint and are never discarded from conservation.',
      'Coverage is exact clipped polygon union within floating-point tolerance. Overlap is union support reached by at least two distinct apply-* task IDs, not repeated 20 ms stamps of the same pass. Unknown, return and dry task scope does not invent a new pass.',
      'Cell area includes field support; excludedArea is its excluded subset. Dose uses treatable support only. Prescription amount is clipped zone support times explicit rate; unprescribed and missed support remain visible.',
      'These are independent simulation-truth coverage and amounts, separate from the quantized host measured-flow ledger. They do not authenticate sensor production, physical delivery or field dose.',
      'Exact geometry has explicit operation and fragment limits and fails on exhaustion. Polygons below 1e-12 square metres are below numerical resolution.',
    ] }
}
export function processApplication(input: ApplicationRun): ApplicationReport {
  const run = validateApplicationRun(input)
  return processApplicationReleases(run.config, run.releases, run.shutdown.finalAtMs)
}
