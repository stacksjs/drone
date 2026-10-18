/** Bounded rectangular boustrophedon strip planner. Footprint includes half a swath around each centerline. */
export function planGroundCoverage(options: { lengthM: number, lanes: number, swathM: number }) {
  const { lengthM, lanes, swathM } = options
  if (!Number.isFinite(lengthM) || lengthM < 1 || lengthM > 4 || !Number.isSafeInteger(lanes) || lanes < 1 || lanes > 3 || !Number.isFinite(swathM) || swathM < 0.5 || swathM > 1) throw new RangeError('Ground coverage supports 1..4m length, 1..3 lanes and 0.5..1m swath')
  const pointsM: [number, number, number][] = []
  for (let lane = 0; lane < lanes; lane++) {
    if (lane > 0) pointsM.push([lane % 2 ? lengthM : 0, lane * swathM, 0])
    pointsM.push([lane % 2 ? 0 : lengthM, lane * swathM, 0])
  }
  return { pointsM, swathM, modeledStripAreaM2: lengthM * lanes * swathM, footprintM: { minNorth: 0, maxNorth: lengthM, minEast: -swathM / 2, maxEast: (lanes - 0.5) * swathM }, limitations: ['rectangular-flat-ground-only', 'no-obstacle-replanning', 'actual-coverage-needs-measured-swath-and-trajectory'] }
}
