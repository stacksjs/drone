import type { AgricultureRun, LivestockObservation } from './types'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createImageData, encode } from 'ts-images'
import { writeCompletedArtifact } from '../../artifacts/completed-directory'
import { agricultureEvidenceLimits, agricultureRecordingJson, validateAgricultureRun, validateLivestockObservations } from './evidence'
import { processAgriculture } from './layer'

function hash(bytes: string | Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }
function json(value: unknown) { return `${JSON.stringify(value, null, 2)}\n` }
/** Exclusive private source, point-sample layer and explicit operator records, published with a completion manifest last. */
export async function writeAgricultureDataset(directory: string, input: AgricultureRun, declarations: readonly LivestockObservation[] = []): Promise<{ directory: string, manifest: string, recording: string, images: number, manifestSha256: string }> {
  if (typeof directory !== 'string' || directory.length < 1 || directory.length > 4096 || directory.includes('\0')) throw new TypeError('Invalid agriculture export directory')
  const run = validateAgricultureRun(input)
  // Batch validation synchronously snapshots all operator declarations before its first digest awaits.
  const observations = await validateLivestockObservations(run, declarations), layer = processAgriculture(run)
  const entries: { path: string, contents: string | Uint8Array }[] = [
    { path: 'recording.json', contents: agricultureRecordingJson(run) },
    { path: 'livestock-observations.json', contents: json(observations) },
    { path: 'layer.json', contents: json(layer) },
    { path: 'parcels.json', contents: json({ version: 1, visitId: run.visitId, fieldAreaM2: layer.fieldAreaM2, observedAreaM2: layer.observedAreaM2, meanNdvi: layer.meanNdvi, parcels: layer.parcels, statistic: 'area-weighted-observed-cell-centre-samples', physicalAgronomyVerified: false }) },
    { path: 'layer.geojson', contents: json({ type: 'FeatureCollection', features: layer.cells.map(cell => ({ type: 'Feature', id: cell.id, geometry: { type: 'Point', coordinates: [cell.geodetic.longitudeDeg, cell.geodetic.latitudeDeg, cell.geodetic.ellipsoidHeightM] }, properties: { localPositionM: cell.positionM, localFrame: 'LOCAL_NED', heightDatum: 'WGS84_ELLIPSOID', areaSupportM2: cell.areaM2, parcelIds: cell.parcelIds, ndvi: cell.ndvi, ndviBounds: cell.bounds, redReflectance: cell.redReflectance, nirReflectance: cell.nirReflectance, source: cell.source, reason: cell.reason } })) }) },
  ]
  const images: Record<string, unknown>[] = []
  let encodedBytes = 0
  for (const capture of run.captures) {
    const raw = capture.image, visible = run.survey.captures.find(frame => frame.id === capture.captureId)!
    const image = createImageData(raw.width, raw.height, { hasAlpha: true, bitDepth: 8 }); image.data.set(raw.rgba)
    const png = await encode(image, 'png'), visiblePath = `images/${capture.captureId}.png`
    entries.push({ path: visiblePath, contents: png }); encodedBytes += png.length
    const bands: Record<string, unknown>[] = []
    for (let index = 0; index < raw.bands.length; index++) {
      const band = raw.bands[index]!, calibration = run.plan.config.radiometry.bands[index]!, bytes = new Uint8Array(band.counts.length * 2), view = new DataView(bytes.buffer)
      for (let i = 0; i < band.counts.length; i++) view.setUint16(i * 2, band.counts[i]!, true)
      const path = `bands/${capture.captureId}-${band.band}.uint16le`
      entries.push({ path, contents: bytes }); encodedBytes += bytes.length
      bands.push({ path, band: band.band, wavelengthNm: calibration.wavelengthNm, bandwidthNm: calibration.bandwidthNm, capturedAtMs: band.capturedAtMs, exposureTimeUs: band.exposureTimeUs, gain: band.gain, irradiance: band.irradiance, encoding: 'uint16-little-endian-row-major-top-left', unit: 'raw-digital-number', byteLength: bytes.length, sha256: hash(bytes), calibration })
    }
    if (encodedBytes > agricultureEvidenceLimits.rawBytes) throw new RangeError('Agriculture encoded dataset resource bound')
    const metadataPath = `bands/${capture.captureId}.json`
    const metadata = { version: 1, visitId: run.visitId, captureId: capture.captureId, sessionId: capture.sessionId, sequence: capture.sequence, reference: capture.reference, issuedAtMs: capture.issuedAtMs, capturedAtMs: capture.capturedAtMs, acknowledgedAtMs: capture.acknowledgedAtMs, width: raw.width, height: raw.height, registrationId: raw.registrationId, registrationErrorPx: raw.registrationErrorPx, visiblePath, pose: visible.pose, bands, radiometryId: run.plan.config.radiometry.id, physicalCalibrationVerified: false }
    entries.push({ path: metadataPath, contents: json(metadata) }); images.push({ ...metadata, metadataPath })
  }
  entries.push({ path: 'README.txt', contents: [
    'Drone calibrated agriculture dataset, version 1', '',
    'Owned-runtime physics simulation only. Physical calibration, field agronomy and animal identity remain unqualified.',
    'recording.json retains acknowledged raw red/NIR uint16 counts, illumination metadata, original visible pixels and compact mission evidence.',
    'images/ contains lossless visible RGBA PNGs. bands/ contains actual raw uint16 little-endian DN planes and metadata, not RGB-derived NIR.',
    'Radiance follows the retained MicaSense-v1 coefficient profile. Reflectance uses per-band panel samples and synchronized downwelling irradiance.',
    'layer.json and layer.geojson retain cell-centre samples, nodata/masks and uncovered support. GeoJSON features are points, not full-cell reflectance polygons.',
    'GeoJSON coordinates are longitude, latitude and WGS84 ellipsoid height. Local positions use fixed-origin north/east/down metres.',
    'Cell and parcel areas are clipped to declared field/holes. Means weight observed point samples by area support without filling or scaling missing areas.',
    'Overlapping captures contribute one nearest qualified view. Raw calibration is cached per frame; no truth model or automatic crop diagnosis supplies the layer.',
    'NDVI uncertainty is conditional on declared calibration, panel, illumination and quantization inputs. It is not an empirical field accuracy bound.',
    'livestock-observations.json contains explicitly supplied operator labels only. Source hashes bind pixels, pose and scope but do not authenticate an animal or observer.',
    'Compact replay checks recorded mission decisions and capture consistency. It does not replay omitted raw sensors or authenticate the producer.',
    'RTK, PPK, measured GCP, physical camera/registration/radiometric qualification and field agronomic validation are unavailable.',
    'manifest.json is the completion marker after private exclusive files and filesystem durability barriers. Content hashes are unsigned.',
    'Local hard-link and directory-fsync support is required. Hardware power-loss durability has not been tested.', '',
  ].join('\n') })
  const manifest = { version: 1, kind: 'calibrated-agriculture-dataset', evidence: run.evidence, visitId: run.visitId, status: run.status, reason: run.reason, images,
    physicalFlightEnabled: false, physicalCalibrationVerified: false, physicalAgronomyVerified: false, physicalAnimalVerified: false, physicalRegistrationVerified: false,
    fullSensorReplayPerformed: false, contentAuthentication: 'unsigned-content-hashes', clockDomain: 'fixture-monotonic-ms', utcAvailable: false,
    localFrame: 'LOCAL_NED', axes: 'NORTH_EAST_DOWN', origin: run.plan.config.survey.origin, geodeticHeightDatum: 'WGS84_ELLIPSOID',
    opticalCalibration: run.plan.config.survey.calibration, heldOut: run.plan.config.survey.heldOut, radiometry: run.plan.config.radiometry,
    reflectanceUnit: 'unitless-ratio', radianceUnit: 'W/m2/sr/nm', irradianceUnit: 'W/m2/nm', ndviDefinition: '(nir-red)/(nir+red)',
    rtk: { status: 'unavailable' }, ppk: { status: 'unavailable' }, gcps: { status: 'unavailable' }, observationCount: observations.length,
    persistence: { protocol: 'exclusive-files-and-directory-fsync-before-manifest-link', hardwarePowerLossTested: false },
    files: entries.map(entry => ({ path: entry.path, bytes: typeof entry.contents === 'string' ? Buffer.byteLength(entry.contents) : entry.contents.length, sha256: hash(entry.contents) })),
  }
  const manifestJson = json(manifest)
  if (Buffer.byteLength(manifestJson) > 16 * 1024 * 1024) throw new RangeError('Agriculture manifest resource bound')
  const output = await writeCompletedArtifact(directory, entries, manifestJson, { directories: ['images', 'bands'] })
  return { ...output, recording: join(output.directory, 'recording.json'), images: images.length, manifestSha256: hash(manifestJson) }
}
