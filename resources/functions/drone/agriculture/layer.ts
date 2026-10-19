import type { AgricultureCell, AgricultureLayer, AgricultureRun } from './types'
import type { SensorVector } from '../sensors/types'
import type { VolumeXY } from '../volumes/types'
import { createCalibratedCamera } from '../camera/calibrated'
import { rotateBodyToNed } from '../controls/physics'
import { nedToGeodetic } from '../estimation/frames'
import { volumeBounds, volumeInsideRing, volumeIntersectConvex, volumeSignedArea, volumeTriangulateRing } from '../volumes/geometry'
import { validateAgricultureRun } from './evidence'
import { calibrateAgricultureImage } from './radiometry'

/** Area-weighted cell-centre samples from real retained raw bands, not an orthomosaic or reconstructed cell-wide crop measurement. */
export function processAgriculture(input: AgricultureRun): AgricultureLayer {
  const run = validateAgricultureRun(input), config = run.plan.config, survey = config.survey
  const [northMinM, eastMinM, northMaxM, eastMaxM] = volumeBounds(survey.boundary), resolutionM = config.gridResolutionM
  const rows = Math.ceil((northMaxM - northMinM) / resolutionM), columns = Math.ceil((eastMaxM - eastMinM) / resolutionM)
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1 || rows * columns > 4096) throw new RangeError('Agriculture layer exceeds 4096 cells')
  const rings = [{ ring: survey.boundary, weight: 1 }, ...survey.holes.map(ring => ({ ring, weight: -1 }))]
  const pieces = rings.flatMap(({ ring, weight }) => volumeTriangulateRing(ring).map(triangle => ({ triangle, weight })))
  function support(bounds: [number, number, number, number]) {
    const [n0, e0, n1, e1] = bounds
    if (n0 >= n1 || e0 >= e1) return 0
    const rectangle: VolumeXY[] = [[n0, e0], [n1, e0], [n1, e1], [n0, e1]]
    let area = 0
    for (const piece of pieces) {
      const clipped = volumeIntersectConvex(piece.triangle, rectangle)
      if (clipped.length >= 3) area += piece.weight * Math.abs(volumeSignedArea(clipped))
    }
    return Math.max(0, area)
  }
  const camera = createCalibratedCamera(survey.calibration, survey.heldOut)
  // One calibration per retained frame. No radiometric recomputation in the cell loop.
  const frames = run.captures.map(raw => ({ raw, visible: run.survey.captures.find(capture => capture.id === raw.captureId)!, calibrated: calibrateAgricultureImage(config.radiometry, raw.image, raw.capturedAtMs) }))
  const parcels = config.parcels.map(parcel => ({ id: parcel.id, name: parcel.name, areaM2: 0, observedAreaM2: 0, weightedNdvi: 0 }))
  const cells: AgricultureCell[] = []
  let fieldAreaM2 = 0, observedAreaM2 = 0, weightedNdvi = 0
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const n1 = northMaxM - row * resolutionM, n0 = Math.max(northMinM, n1 - resolutionM), e0 = eastMinM + column * resolutionM, e1 = Math.min(eastMaxM, e0 + resolutionM)
    const north = (n0 + n1) / 2, east = (e0 + e1) / 2
    const positionM: SensorVector = [north, east, survey.terrain.downAtOriginM + survey.terrain.gradient[0] * north + survey.terrain.gradient[1] * east]
    const bounds: [number, number, number, number] = [n0, e0, n1, e1], areaM2 = support(bounds)
    const parcelAreas = config.parcels.map(parcel => support([Math.max(n0, parcel.boundsM[0]), Math.max(e0, parcel.boundsM[1]), Math.min(n1, parcel.boundsM[2]), Math.min(e1, parcel.boundsM[3])]))
    const parcelIds = parcelAreas.flatMap((area, i) => area > 1e-10 ? [config.parcels[i]!.id] : [])
    const cell: AgricultureCell = { id: `cell-${row}-${column}`, positionM, geodetic: nedToGeodetic(positionM, survey.origin), areaM2, parcelIds, ndvi: null, bounds: null, redReflectance: null, nirReflectance: null, source: null, reason: 'uncovered' }
    // Partial support does not imply the centre is inside the clipped field. Such cells remain missing.
    const point: VolumeXY = [north, east]
    if (areaM2 > 1e-10 && volumeInsideRing(point, survey.boundary) && !survey.holes.some(hole => volumeInsideRing(point, hole))) {
      let selected: { frame: typeof frames[number], pixel: [number, number], distanceM: number } | null = null
      for (const frame of frames) {
        if (!frame.calibrated.qualified) continue
        const q = frame.visible.pose.quaternionWxyz, delta = positionM.map((n, i) => n - frame.visible.pose.positionM[i]!) as SensorVector
        const bodyPoint = rotateBodyToNed([q[0], -q[1], -q[2], -q[3]], delta)
        const projected = camera.projectBodyPoint(bodyPoint)
        if (!projected || projected[0] < 0 || projected[1] < 0 || projected[0] >= frame.raw.image.width || projected[1] >= frame.raw.image.height) continue
        const distanceM = Math.hypot(...positionM.map((n, i) => n - frame.visible.pose.cameraPositionM[i]!))
        if (!selected || distanceM < selected.distanceM) selected = { frame, pixel: [Math.floor(projected[0]), Math.floor(projected[1])], distanceM }
      }
      if (selected) {
        const { frame, pixel } = selected, index = pixel[1] * frame.raw.image.width + pixel[0]
        cell.source = { captureId: frame.raw.captureId, pixel, positionSigmaM: frame.visible.pose.positionSigmaM }
        if (frame.calibrated.valid[index] === 1) {
          cell.ndvi = frame.calibrated.ndvi[index]!
          cell.bounds = [frame.calibrated.lower[index]!, frame.calibrated.upper[index]!]
          cell.redReflectance = frame.calibrated.red[index]!; cell.nirReflectance = frame.calibrated.nir[index]!
          cell.reason = 'valid'
        }
        else cell.reason = 'masked'
      }
    }
    fieldAreaM2 += areaM2
    if (cell.ndvi !== null) { observedAreaM2 += areaM2; weightedNdvi += areaM2 * cell.ndvi }
    for (let i = 0; i < parcels.length; i++) {
      const parcel = parcels[i]!, area = parcelAreas[i]!
      parcel.areaM2 += area
      if (cell.ndvi !== null) { parcel.observedAreaM2 += area; parcel.weightedNdvi += area * cell.ndvi }
    }
    cells.push(cell)
  }
  return { version: 1, visitId: run.visitId, grid: { northMinM, eastMinM, northMaxM, eastMaxM, rows, columns, resolutionM }, cells,
    parcels: parcels.map(parcel => ({ id: parcel.id, name: parcel.name, areaM2: parcel.areaM2, observedAreaM2: parcel.observedAreaM2, meanNdvi: parcel.observedAreaM2 > 0 ? parcel.weightedNdvi / parcel.observedAreaM2 : null, missingAreaM2: Math.max(0, parcel.areaM2 - parcel.observedAreaM2) })),
    fieldAreaM2, observedAreaM2, meanNdvi: observedAreaM2 > 0 ? weightedNdvi / observedAreaM2 : null, physicalAgronomyVerified: false,
    limitations: [
      'Grid-centre nearest-view sampling of retained calibrated raw bands using estimated capture poses. No truth lookup, interpolation, orthomosaic or reconstruction.',
      'Cell and parcel support areas are exactly clipped to the declared field and holes. A point sample is weighted by that support; it does not measure reflectance over the whole cell.',
      'Boundary edge cells may be smaller than the nominal resolution. Positive-area cells whose centre lies outside the field or inside a hole remain missing.',
      'Overlapping images contribute one nearest qualified view per cell, without double-counting area. A masked nearest pixel stays missing rather than silently selecting a different observation.',
      'NDVI bounds are conditional on declared panel, calibration, quantization and irradiance inputs. Pose, registration, terrain and unresolved within-cell variation remain separate limits.',
      'Missing, nodata and masked supports are retained without percentage scaling. Parcel means describe observed area-weighted samples only.',
      'All sampled materials contribute to summaries. No vegetation or animal segmentation removes mixed non-crop material from the field statistics.',
      'No crop health diagnosis, yield forecast, spray prescription, field radiometric accuracy or physical agronomy has been verified.',
    ] }
}
