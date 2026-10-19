import type { MissionPlan } from '../missions/plan'
import type { SurveyConfig, SurveyPlan, SurveyPoint } from '../mapping/types'
import type { SurveyShutterCommand } from '../mapping/camera'

export type IncidentPurpose = 'search-and-rescue' | 'fire-observation' | 'disaster-assessment' | 'lawful-police-observation'
export interface PublicSafetyConfig {
  version: 1
  id: string
  revision: string
  visitId: string
  purpose: IncidentPurpose
  policyId: string
  purposeAuthority: { status: 'simulation-declared' | 'unqualified', reference: string | null }
  retention: { policyId: string, expiresAt: string, hold: 'none' | 'declared-review-required' }
  survey: SurveyConfig
  operatingBoundary: SurveyPoint[]
  noObserveZones: SurveyPoint[][]
  sectors: { id: string, boundary: SurveyPoint[] }[]
  sectorId: string
}
export interface PublicSafetyPlan {
  version: 1
  config: PublicSafetyConfig
  survey: SurveyPlan
  mission: MissionPlan
  sectorId: string
  searchAreaM2: number
  assumptions: string[]
}
/** 0 means unobserved, 1 means observed, 2 means privacy masked before storage. */
export interface PublicSafetyImage {
  width: number
  height: number
  rgba: Uint8Array
  thermalCentiKelvin: Uint16Array
  support: Uint8Array
}
export interface PublicSafetyThermalAck extends SurveyShutterCommand {
  capturedAtMs: number
  acknowledgedAtMs: number
  width: number
  height: number
  thermalCentiKelvin: Uint16Array
  support: Uint8Array
}
