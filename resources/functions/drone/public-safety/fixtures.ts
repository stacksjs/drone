import type { IncidentPurpose, PublicSafetyConfig } from './types'
import { exampleSurveyConfig } from '../mapping/fixtures'

/** Synthetic-only incident sector. This declaration grants no legal or physical authority. */
export function examplePublicSafetyConfig(purpose: IncidentPurpose = 'search-and-rescue'): PublicSafetyConfig {
  const survey = exampleSurveyConfig()
  survey.id = 'synthetic-incident-sector'
  return {
    version: 1, id: 'synthetic-incident', revision: 'revision-1', visitId: 'visit-1', purpose, policyId: 'simulation-observation',
    purposeAuthority: { status: 'simulation-declared', reference: 'synthetic-fixture-only' },
    retention: { policyId: 'synthetic-retention', expiresAt: '2027-01-01T00:00:00.000Z', hold: 'none' },
    survey, operatingBoundary: [[-3, -3], [3, -3], [3, 3], [-3, 3]],
    noObserveZones: [[[.45, .45], [.65, .45], [.65, .65], [.45, .65]]],
    sectors: [{ id: 'sector-1', boundary: structuredClone(survey.boundary) }], sectorId: 'sector-1',
  }
}
