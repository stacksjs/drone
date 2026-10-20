import type { GimbalCommandToken, GimbalInhibitCode, GimbalPhase } from '../payloads/gimbal-authority'
import type { CinemaCapture, CinemaFaultCode, CinemaRun, CinemaShot } from './types'
export type { GimbalInhibitCode } from '../payloads/gimbal-authority'
export const cinemaManagedScenarios = ['nominal', 'source-expiry-with-foreign'] as const
export type CinemaManagedScenario = typeof cinemaManagedScenarios[number]
export interface CinemaManagerEvidence {
  version: 1
  evidence: 'owned-selected-gimbal-source-simulation'
  physicalActuationEnabled: false
  identityAuthenticated: false
  policy: { profile: 'relative-joint-angle-v1', frame: 'BODY_FRD_RELATIVE_JOINTS', commandAgeMs: 100, minLeaseMs: 20, maxLeaseMs: 100, maxPolicyGapMs: 40, travelRad: [[number, number], [number, number], [number, number]] }
  selection: { kind: 'autonomy', sourceId: 'cinema-autonomy-v1', sessionId: 'cinema-gimbal-source-v1', reference: '55:0,0,0,0,0' }
  lastAccepted: GimbalCommandToken | null
  firstInhibit: { atMs: number, code: GimbalInhibitCode } | null
  retirement: { atMs: number, directive: 'zero-requested-torque' }
  counters: { acceptedCommands: number, rejectedForeignCommands: number, rejectedSelectedCommands: number, commandsAfterRetirement: 0 }
  transitions: { atMs: number, from: GimbalPhase, to: GimbalPhase, reason: 'selected-command' | GimbalInhibitCode | 'session-retired' }[]
  captureCommands: { captureSequence: 1 | 2 | 3, atMs: number, command: GimbalCommandToken }[]
  foreignRejections: { atMs: number, sourceKind: 'operator', sourceId: 'foreign-operator-v1', selectedIssuedAtMs: number, selectedExpiresAtMs: number, rejection: 'foreign' }[]
}
export type CinemaManagedCapture = Omit<CinemaCapture, 'reason'> & { reason: CinemaCapture['reason'] | GimbalInhibitCode }
export type CinemaManagedShot = Omit<CinemaShot, 'firstFault'> & { firstFault: { atMs: number, code: CinemaFaultCode | GimbalInhibitCode } | null }
export type CinemaManagedRun = Omit<CinemaRun, 'version' | 'evidence' | 'profile' | 'scenario' | 'reason' | 'shot' | 'captures'> & { version: 2, evidence: 'owned-managed-cinema-hover-reframe-simulation', profile: 'managed-hover-poi-reframe-v1', scenario: CinemaManagedScenario, reason: CinemaRun['reason'] | GimbalInhibitCode, shot: CinemaManagedShot, captures: CinemaManagedCapture[], manager: CinemaManagerEvidence }
