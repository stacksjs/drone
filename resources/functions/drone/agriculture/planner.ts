import type { AgricultureConfig, AgriculturePlan } from './types'
import { createSurveyPlan } from '../mapping/planner'
import { validateAgricultureRadiometry } from './radiometry'

function fail(message: string): never { throw new TypeError(`Invalid agriculture plan: ${message}`) }
function fields(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail('fields')
}
function bounded(input: unknown) {
  let nodes = 0, bytes = 0
  const ancestors = new Set<object>()
  function visit(value: unknown, depth: number) {
    if (++nodes > 20000 || depth > 20) fail('config resource bound')
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('non-finite config'); bytes += 24 }
    else if (typeof value === 'string') { if (value.length > 2000) fail('text bound'); bytes += value.length * 3 + 2 }
    else if (typeof value === 'boolean' || value === null) bytes += 5
    else if (Array.isArray(value) || (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)) {
      if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) fail('cyclic or symbolic config')
      if (Array.isArray(value) && value.length > 4096) fail('array bound')
      ancestors.add(value)
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!('value' in descriptor)) fail('accessor config')
        bytes += key.length * 3 + 4
        visit(descriptor.value, depth + 1)
      }
      ancestors.delete(value)
    }
    else fail('unsupported config value')
    if (bytes > 8 * 1024 * 1024) fail('config byte bound')
  }
  visit(input, 0)
}
const id = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)

/** Plan the existing owned survey route and retain explicit raw-band calibration and parcel support. */
export function createAgriculturePlan(input: unknown): AgriculturePlan {
  bounded(input)
  fields(input, ['version', 'id', 'survey', 'parcels', 'radiometry', 'gridResolutionM'])
  const config = structuredClone(input) as AgricultureConfig
  if (config.version !== 1 || !id(config.id)) fail('version or identity')
  const survey = createSurveyPlan(config.survey)
  if (survey.config.id !== config.id) fail('survey identity')
  const { width, height } = survey.config.calibration.output
  if (width * height > 65536) fail('pixel bound')
  config.radiometry = validateAgricultureRadiometry(config.radiometry, width, height)
  if (!Number.isFinite(config.gridResolutionM) || config.gridResolutionM < .025 || config.gridResolutionM > 2) fail('grid resolution')
  const ns = survey.config.boundary.map(p => p[0]), es = survey.config.boundary.map(p => p[1])
  const rows = Math.ceil((Math.max(...ns) - Math.min(...ns)) / config.gridResolutionM), columns = Math.ceil((Math.max(...es) - Math.min(...es)) / config.gridResolutionM)
  if (rows * columns > 4096) fail('grid cell bound')
  if (!Array.isArray(config.parcels) || config.parcels.length < 1 || config.parcels.length > 32) fail('parcel count')
  const ids = new Set<string>()
  for (const parcel of config.parcels) {
    fields(parcel, ['id', 'name', 'boundsM'])
    if (!id(parcel.id) || ids.has(parcel.id) || typeof parcel.name !== 'string' || !parcel.name.trim() || parcel.name.length > 100 || /[\u0000-\u001F\u007F]/.test(parcel.name)) fail('parcel identity')
    ids.add(parcel.id)
    if (!Array.isArray(parcel.boundsM) || parcel.boundsM.length !== 4 || parcel.boundsM.some(n => !Number.isFinite(n) || Math.abs(n) > 100) || parcel.boundsM[0] >= parcel.boundsM[2] || parcel.boundsM[1] >= parcel.boundsM[3]) fail('parcel bounds')
    if (parcel.boundsM[2] <= Math.min(...ns) || parcel.boundsM[0] >= Math.max(...ns) || parcel.boundsM[3] <= Math.min(...es) || parcel.boundsM[1] >= Math.max(...es)) fail('parcel outside field bounds')
  }
  for (let i = 0; i < config.parcels.length; i++) for (let j = i + 1; j < config.parcels.length; j++) {
    const a = config.parcels[i]!.boundsM, b = config.parcels[j]!.boundsM
    if (Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 1e-9 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 1e-9) fail('parcel interiors overlap')
  }
  return { version: 1, config: { ...config, survey: survey.config }, survey, assumptions: [
    ...survey.assumptions,
    'Raw red/NIR counts share an explicitly registered optical grid; visible colours are not NIR measurements.',
    'Panel and irradiance declarations condition the reflectance calculation; physical calibration and agronomic accuracy are unverified.',
    'Parcel rectangles are clipped to the surveyed field and holes. Reports use area-weighted grid-centre samples, not a reconstructed orthomosaic.',
    'Animal labels require explicit operator-selected capture pixels and never establish automatic identity.',
  ] }
}
