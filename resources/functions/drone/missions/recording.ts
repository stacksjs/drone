import type { MissionObservation, MissionTrace } from './engine'
import type { VehicleMissionObservation } from '../vehicles/types'
import type { VehicleMissionTrace } from './vehicle'
import { checkpointMission, parseMissionTrace, recoverMission, replayMission, resumeMission } from './engine'
import { checkpointVehicleMission, parseVehicleMissionTrace, recoverVehicleMission, replayVehicleMission, resumeVehicleMission, vehicleMissionLimits } from './vehicle'

export type OwnedMissionTrace = MissionTrace | VehicleMissionTrace
/** Explicit version dispatch. Both parsers recompute every recorded decision. */
export function parseOwnedMissionTrace(text: string): OwnedMissionTrace {
  if (new TextEncoder().encode(text).length > vehicleMissionLimits.bytes) throw new RangeError('Mission recording exceeds 16 MiB')
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new TypeError('Invalid mission trace JSON') }
  if (!value || typeof value !== 'object' || !('version' in value)) throw new TypeError('Invalid mission trace version')
  if (value.version === 1) return parseMissionTrace(text)
  if (value.version === 2 || value.version === 3 && 'evidence' in value && value.evidence === 'owned-vehicle-mission-simulation') return parseVehicleMissionTrace(text)
  throw new TypeError('Unsupported mission trace version')
}
export function replayOwnedMission(trace: OwnedMissionTrace) {
  return trace.version === 1 ? replayMission(trace) : replayVehicleMission(trace)
}
export function checkpointOwnedMission(trace: OwnedMissionTrace, atMs: number): OwnedMissionTrace {
  return trace.version === 1 ? checkpointMission(trace, atMs) : checkpointVehicleMission(trace, atMs)
}
/** Observation casts select a validator, never establish trusted authority. */
export function recoverOwnedMission(trace: OwnedMissionTrace, observation: unknown) {
  return trace.version === 1 ? recoverMission(trace, observation as MissionObservation) : recoverVehicleMission(trace, observation as VehicleMissionObservation)
}
export function resumeOwnedMission(trace: OwnedMissionTrace, observation: unknown) {
  return trace.version === 1 ? resumeMission(trace, observation as MissionObservation) : resumeVehicleMission(trace, observation as VehicleMissionObservation)
}
/** Validate the entire source, including rows beyond the selected playback epoch. */
export function replayOwnedMissionAt(trace: OwnedMissionTrace, atMs?: number) {
  const verified = replayOwnedMission(trace).trace()
  const at = atMs ?? verified.rows.at(-1)?.observation.nowMs ?? 0
  const maximumMs = trace.version === 1 ? 120000 : vehicleMissionLimits.maximumMs
  if (!Number.isSafeInteger(at) || at < 0 || at > maximumMs) throw new RangeError(`Replay epoch must be an integer from 0..${maximumMs} ms`)
  // Narrow each variant to preserve its observation and result types.
  if (verified.version === 1) verified.rows = verified.rows.filter(row => row.observation.nowMs <= at)
  else verified.rows = verified.rows.filter(row => row.observation.nowMs <= at)
  return replayOwnedMission(verified)
}
