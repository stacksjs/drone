export type VolumePoint = [eastM: number, northM: number, elevationM: number]
export type VolumeXY = [eastM: number, northM: number]
export interface SurfaceReference {
  horizontalCrs: { kind: 'wgs84-utm' | 'engineering', id: string, definition: string, coordinateEpoch: string | null }
  axes: 'EAST_NORTH'
  horizontalUnit: 'metre'
  verticalDatum: { kind: 'ellipsoidal' | 'orthometric' | 'engineering', id: string, definition: string }
  verticalUnit: 'metre'
  elevationPositive: 'up'
}
export interface SurfaceStage { status: 'synthetic' | 'external' | 'unknown', sourceId: string | null }
export interface SurfaceCalibration { status: 'not-applicable' | 'unknown' | 'declared', reportId: string | null }
export interface SurfaceMetadata {
  version: 1
  id: string
  reference: SurfaceReference
  provenance: {
    evidence: 'synthetic' | 'operator-imported'
    sourceKind: 'analytic' | 'lidar' | 'photogrammetry' | 'surveyed-mesh'
    sourceSha256: string
    acquisition: SurfaceStage
    reconstructionOrMeshing: SurfaceStage
    boresightCalibration: SurfaceCalibration
    timeCalibration: SurfaceCalibration
    groundClassification: { status: 'unknown' | 'declared', description: string, reportId: string | null }
    georeferencing: { verticalBoundM: number | null, horizontalBoundM: number | null, reportId: string | null }
  }
}
export type SurfaceGeometry =
  | { kind: 'tin', vertices: VolumePoint[], triangles: [number, number, number][] }
  | { kind: 'cell-grid', width: number, height: number, westM: number, southM: number, cellSizeM: number, rows: (number | null)[][], rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' }
export interface KnownSurface { version: 1, metadata: SurfaceMetadata, geometry: SurfaceGeometry }
export interface VolumeBoundary { outer: VolumeXY[], holes: VolumeXY[][] }
export interface VolumeBase { kind: 'plane', anchorM: VolumePoint, gradientEast: number, gradientNorth: number, assumption: string, evidence: 'synthetic' | 'operator-assumed' | 'operator-declared-survey', verticalBoundM: number | null }
export interface VolumeReference {
  id: string
  evidence: 'synthetic' | 'operator-declared-survey'
  sourceSha256: string
  surveyedAt: string
  method: string
  independence: 'declared-independent' | 'not-independent'
  reference: SurfaceReference
  boundary: VolumeBoundary
  base: VolumeBase
  aboveBaseM3: number
  belowBaseM3: number
  volumeBoundM3: number | null
}
export interface VolumeRequest { version: 1, id: string, surface: KnownSurface, boundary: VolumeBoundary, base: VolumeBase, reference: VolumeReference | null }
export interface VolumePiece {
  sourceId: string
  boundaryPart: string
  weight: 1 | -1
  polygonM: VolumeXY[]
  areaM2: number
  aboveBaseM3: number
  belowBaseM3: number
  signedTopMinusBaseM3: number
}
export interface VolumeReport {
  version: 1
  id: string
  method: 'clipped-affine-surface-plane-v1'
  evidence: 'synthetic' | 'operator-imported'
  physicalActuationEnabled: false
  acquisitionPerformed: false
  reconstructionPerformed: false
  physicalAccuracyVerified: false
  status: 'covered-domain' | 'partial-coverage'
  reference: SurfaceReference
  boundaryAreaM2: number
  coveredAreaM2: number
  uncoveredAreaM2: number
  coverageFraction: number
  aboveBaseM3: number
  belowBaseM3: number
  signedTopMinusBaseM3: number
  fullBoundarySignedM3: number | null
  integrationPieces: VolumePiece[]
  excludedGridCells: { row: number, column: number }[]
  uncertainty: { conditionalVerticalBoundM3: number | null, overallAccuracyBoundM3: null, horizontalBoundM: number | null, assumptions: string[] }
  comparison: { status: 'unavailable' | 'not-independent' | 'synthetic-comparison' | 'operator-declared-reference', aboveDifferenceM3: number | null, belowDifferenceM3: number | null, signedDifferenceM3: number | null, relativeSignedDifference: number | null, combinedDeclaredBoundM3: number | null, withinCombinedDeclaredBound: boolean | null }
  warnings: string[]
  limitations: string[]
}
