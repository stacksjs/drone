import type { AgricultureRun, AgricultureScenario } from './types'
import type { SurveyScenario } from '../mapping/runtime'
import { simulateSurvey } from '../mapping/runtime'
import { createAgriculturePlan } from './planner'
import { exampleAgricultureConfig } from './fixtures'
import { createAgricultureCamera } from './camera'

export const agricultureScenarios = ['nominal', 'irradiance-loss', 'band-skew', 'saturation', 'camera-loss', 'wrong-ack', 'position-loss', 'rc-override', 'abort'] as const
/** Numeric bands and visible pixels share the actual owned survey estimator, mission and shutter epochs. */
export function simulateAgriculture(options: { config?: unknown, scenario?: AgricultureScenario, seconds?: number, visitId?: string } = {}): AgricultureRun {
  const scenario = options.scenario ?? 'nominal', visitId = options.visitId ?? 'agriculture-visit-1'
  if (!agricultureScenarios.includes(scenario) || !/^[a-z][a-z0-9-]{0,63}$/.test(visitId)) throw new RangeError('Invalid agriculture scenario or visit')
  const plan = createAgriculturePlan(options.config ?? exampleAgricultureConfig())
  if (plan.config.radiometry.evidence !== 'synthetic') throw new RangeError('Owned agriculture requires synthetic radiometric calibration')
  const camera = createAgricultureCamera(plan, scenario)
  const surveyScenario: SurveyScenario = scenario === 'position-loss' || scenario === 'rc-override' || scenario === 'abort' ? scenario : 'nominal'
  const survey = simulateSurvey({ config: plan.config.survey, scenario: surveyScenario, seconds: options.seconds, cameraFactory: () => camera })
  const captures = camera.captures()
  if (captures.length !== survey.captures.length || captures.some((capture, i) => capture.captureId !== survey.captures[i]!.id || capture.capturedAtMs !== survey.captures[i]!.capturedAtMs)) throw new Error('Agriculture capture and survey acknowledgment join differs')
  return { version: 1, evidence: 'owned-agriculture-physics-simulation', physicalFlightEnabled: false, physicalCalibrationVerified: false, visitId, scenario, plan, survey, captures, status: survey.status, reason: camera.failure() ?? survey.reason }
}
