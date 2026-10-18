import type { KnownSurface, SurfaceMetadata, VolumeRequest } from './types'
import { validateKnownSurface, validateSurfaceMetadata, validateVolumeRequest, volumeLimits } from './engine'

/** Format parsing is bounded independently of the file reader, including browser callers. */
export const surfaceImportLimits = Object.freeze({ textBytes: 8 * 1024 * 1024, lineCharacters: 1024 * 1024, requestBytes: 16 * 1024 * 1024 })

function boundedText(input: unknown, maximumBytes = surfaceImportLimits.textBytes): string {
  if (typeof input !== 'string' || input.length > maximumBytes || new TextEncoder().encode(input).byteLength > maximumBytes)
    throw new Error(`Surface text must fit within ${maximumBytes} UTF-8 bytes`)
  return input
}

function asciiLines(input: unknown): string[] {
  const text = boundedText(input)
  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(text))
    throw new Error('Surface format requires ASCII text without a BOM')
  let newlineCount = 0
  for (const character of text) {
    if (character === '\n' && ++newlineCount > volumeLimits.vertices + volumeLimits.primitives + 128)
      throw new Error('Surface record count exceeds the supported budget')
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.some(line => line.length > surfaceImportLimits.lineCharacters || line.includes('\r')))
    throw new Error('Surface contains an oversized line or unsupported line ending')
  while (lines.at(-1)?.trim() === '')
    lines.pop()
  return lines.map(line => line.trim())
}

function numeric(token: string | undefined, label: string): number {
  if (!token || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token))
    throw new Error(`${label} must be a finite decimal number`)
  const value = Number(token)
  if (!Number.isFinite(value))
    throw new Error(`${label} must be a finite decimal number`)
  return value
}

function count(token: string | undefined, label: string, maximum: number): number {
  if (!token || !/^\d+$/.test(token))
    throw new Error(`${label} must be a positive integer`)
  const value = Number(token)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${label} exceeds the supported count ${maximum}`)
  return value
}

/** Exact UTF-8 source integrity only; a hash does not authenticate the survey. */
export async function surfaceSourceDigest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(boundedText(text))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sourceMetadata(text: string, input: SurfaceMetadata): Promise<SurfaceMetadata> {
  const metadata = validateSurfaceMetadata(input)
  if (await surfaceSourceDigest(text) !== metadata.provenance.sourceSha256)
    throw new Error('Surface source SHA256 does not match the metadata sidecar')
  return metadata
}

/** Square, corner-origin AAIGrid cells; center-origin point samples need a separate area model. */
export async function importGridSurface(text: string, input: SurfaceMetadata): Promise<KnownSurface> {
  const lines = asciiLines(text)
  const metadata = await sourceMetadata(text, input)
  const fields = new Map<string, string>()
  let cursor = 0
  const supported = new Set(['ncols', 'nrows', 'xllcorner', 'yllcorner', 'cellsize', 'nodata_value'])
  while (cursor < lines.length) {
    const tokens = lines[cursor]!.split(/\s+/)
    const key = tokens[0]!.toLowerCase()
    if (/^[+-]?(?:\d|\.)/.test(key))
      break
    if (key === 'xllcenter' || key === 'yllcenter')
      throw new Error('AAIGrid center-origin point samples are unsupported; provide an explicit corner-origin cell-area product')
    if (!supported.has(key) || tokens.length !== 2 || fields.has(key))
      throw new Error(`Unsupported, duplicate or malformed AAIGrid header: ${key}`)
    fields.set(key, tokens[1]!)
    cursor++
  }
  const width = count(fields.get('ncols'), 'AAIGrid ncols', volumeLimits.gridCells)
  const height = count(fields.get('nrows'), 'AAIGrid nrows', volumeLimits.gridCells)
  if (width * height > volumeLimits.gridCells)
    throw new Error('AAIGrid cell count exceeds the supported budget')
  const westM = numeric(fields.get('xllcorner'), 'AAIGrid xllcorner')
  const southM = numeric(fields.get('yllcorner'), 'AAIGrid yllcorner')
  const cellSizeM = numeric(fields.get('cellsize'), 'AAIGrid cellsize')
  if (cellSizeM <= 0)
    throw new Error('AAIGrid cellsize must be positive')
  const nodata = fields.has('nodata_value') ? numeric(fields.get('nodata_value'), 'AAIGrid NODATA_value') : null
  if (lines.length - cursor !== height)
    throw new Error('AAIGrid requires exactly nrows data records')
  const rows = lines.slice(cursor).map((line, row) => {
    const tokens = line.split(/\s+/)
    if (tokens.length !== width)
      throw new Error(`AAIGrid row ${row} must contain exactly ncols cells`)
    return tokens.map((token, column) => {
      const value = numeric(token, `AAIGrid cell ${row},${column}`)
      return nodata !== null && value === nodata ? null : value
    })
  })
  return validateKnownSurface({ version: 1, metadata, geometry: { kind: 'cell-grid', width, height, westM, southM, cellSizeM, rows, rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' } })
}

/** A known indexed terrain mesh, never a raw point-cloud triangulator. */
export async function importPlySurface(text: string, input: SurfaceMetadata): Promise<KnownSurface> {
  const lines = asciiLines(text)
  const metadata = await sourceMetadata(text, input)
  let cursor = 0
  if (lines[cursor++] !== 'ply' || lines[cursor++] !== 'format ascii 1.0')
    throw new Error('PLY requires format ascii 1.0')
  const header: string[] = []
  while (cursor < lines.length && lines[cursor] !== 'end_header') {
    const line = lines[cursor++]!
    if (line.startsWith('comment '))
      continue
    header.push(line)
    if (header.length > 7)
      throw new Error('PLY unsupported element or property; only indexed x/y/z triangular surfaces are accepted')
  }
  if (lines[cursor++] !== 'end_header' || header.length !== 6)
    throw new Error('PLY requires vertices, x/y/z properties and indexed triangular faces')
  const vertexDeclaration = /^element vertex (\d+)$/.exec(header[0]!)
  const vertexCount = count(vertexDeclaration?.[1], 'PLY vertices', volumeLimits.vertices)
  for (let axis = 0; axis < 3; axis++) {
    if (!new RegExp(`^property (?:float|double) ${['x', 'y', 'z'][axis]}$`).test(header[axis + 1]!))
      throw new Error('PLY supports only x/y/z float or double vertex properties in that order; unsupported properties are not discarded')
  }
  const faceDeclaration = /^element face (\d+)$/.exec(header[4]!)
  const faceCount = count(faceDeclaration?.[1], 'PLY faces', volumeLimits.primitives)
  if (!/^property list uchar int vertex_ind(?:ices|ex)$/.test(header[5]!))
    throw new Error('PLY requires property list uchar int vertex_indices (or vertex_index)')
  if (lines.length - cursor !== vertexCount + faceCount)
    throw new Error('PLY data must exactly match declared vertex and face counts')
  const vertices = lines.slice(cursor, cursor + vertexCount).map((line, index) => {
    const tokens = line.split(/\s+/)
    if (tokens.length !== 3)
      throw new Error(`PLY vertex ${index} requires exactly three coordinates`)
    return [numeric(tokens[0], 'PLY x'), numeric(tokens[1], 'PLY y'), numeric(tokens[2], 'PLY z')]
  })
  cursor += vertexCount
  const triangles = lines.slice(cursor).map((line, index) => {
    const tokens = line.split(/\s+/)
    if (tokens.length !== 4 || tokens[0] !== '3')
      throw new Error(`PLY face ${index} must be triangular; raw points and nontriangular faces need explicit meshing`)
    return tokens.slice(1).map(token => {
      if (!/^\d+$/.test(token))
        throw new Error('PLY face indices must be nonnegative integers')
      const value = Number(token)
      if (!Number.isSafeInteger(value) || value >= vertexCount)
        throw new Error('PLY face index is outside the vertex table')
      return value
    })
  })
  return validateKnownSurface({ version: 1, metadata, geometry: { kind: 'tin', vertices, triangles } })
}

export function parseVolumeRequest(text: string): VolumeRequest {
  return validateVolumeRequest(JSON.parse(boundedText(text, surfaceImportLimits.requestBytes)))
}

export function exportGridSurface(input: KnownSurface): string {
  const surface = validateKnownSurface(input)
  if (surface.geometry.kind !== 'cell-grid')
    throw new Error('AAIGrid export requires a cell-grid surface')
  const grid = surface.geometry
  const values = new Set(grid.rows.flat().filter(value => value !== null))
  let nodata = -9999
  while (values.has(nodata))
    nodata *= 10
  return [`ncols ${grid.width}`, `nrows ${grid.height}`, `xllcorner ${grid.westM}`, `yllcorner ${grid.southM}`, `cellsize ${grid.cellSizeM}`, `NODATA_value ${nodata}`, ...grid.rows.map(row => row.map(value => value === null ? nodata : value).join(' ')), ''].join('\n')
}

export function exportPlySurface(input: KnownSurface): string {
  const surface = validateKnownSurface(input)
  if (surface.geometry.kind !== 'tin')
    throw new Error('PLY export requires an indexed TIN surface')
  const mesh = surface.geometry
  return ['ply', 'format ascii 1.0', `element vertex ${mesh.vertices.length}`, 'property double x', 'property double y', 'property double z', `element face ${mesh.triangles.length}`, 'property list uchar int vertex_indices', 'end_header', ...mesh.vertices.map(point => point.join(' ')), ...mesh.triangles.map(face => `3 ${face.join(' ')}`), ''].join('\n')
}
