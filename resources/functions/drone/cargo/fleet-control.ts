import { createCargoFleetSession } from './fleet'

export const cargoFleetOperatorCases = ['cancel', 'cancel-resume', 'cancel-after-grant', 'resume-after-navigation-loss'] as const
type OperatorCase = typeof cargoFleetOperatorCases[number]
function captureCase(input: unknown): OperatorCase {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => key !== 'case')) throw new TypeError()
    const d = Object.getOwnPropertyDescriptor(input, 'case')
    if (d && (!d.enumerable || !Object.hasOwn(d, 'value') || !cargoFleetOperatorCases.some(name => name === d.value))) throw new TypeError()
    return (d?.value ?? 'cancel-resume') as OperatorCase
  }
  catch { throw new TypeError('cargo-fleet-control-arguments') }
}

/** Explicit fictional operator decisions over the retained world, without hardware dispatch. */
export function simulateCargoFleetControl(input: unknown = {}, ...extra: unknown[]) {
  if (extra.length) throw new TypeError('cargo-fleet-control-arguments')
  const name = captureCase(input), world = createCargoFleetSession({ scenario: name === 'resume-after-navigation-loss' ? 'receiver-navigation-loss-during-rail' : 'nominal' })
  let cancelled = false, resumed = false
  try {
    for (let nowMs = 0; ; nowMs += 4) {
      const progress = world.step(nowMs), state = world.snapshot()
      if (progress.terminal) return { case: name, run: world.result() }
      const decide = (action: 'cancel' | 'resume', sequence: number) => world.decide({ version: 1, evidence: 'modeled-cargo-transport-decision-v1', contextId: state.operator.contextId,
        bootId: state.receiver!.authority.bootId, sessionId: state.receiver!.authority.sessionId, sequence, issuedAtMs: nowMs, reference: state.receiver!.reference, sourceEventId: state.stationSourceEventId, action })
      const cancelNow = name === 'cancel-after-grant' ? state.intake.custody.grantedAtMs !== null
        : state.station?.phase === 'moving' && (name === 'resume-after-navigation-loss' || Math.hypot(...state.station.parcel!.velocityMps) > .1)
      if (!cancelled && cancelNow) { decide('cancel', 1); cancelled = true }
      else if (cancelled && !resumed && name !== 'cancel') {
        const resumeNow = name === 'cancel-after-grant' || (name === 'resume-after-navigation-loss' ? state.receiver?.authority.state === 'failsafe'
          : state.station?.phase === 'cancelled' && state.station.stoppedAtMs !== null && nowMs >= state.station.stoppedAtMs + 1000)
        if (resumeNow) { decide('resume', 2); resumed = true }
      }
    }
  }
  finally { world.close() }
}
