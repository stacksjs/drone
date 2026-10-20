import type { ContactProfile, ContactBinding, ContactPacket, ContactHostObservation, ContactVerification } from './contact'
import { contactProfiles, contactModel, createContactFeed, initialContactVerification, reduceContactVerification, contactEligibility } from './contact'
import type { ImuMeasurement } from '../sensors/types'
import type { Motors } from '../controls/model'
import type { MissionAction, MissionSnapshot } from '../missions/engine'
import type { NavigationDecision, NavigationIntent } from './navigator'
import type { NavigationMap, NavigationPose } from './perception'
import { detectNavigationMap } from './perception'
import { createNavigationSensorFeed } from './sensors'
import { createNavigator } from './navigator'
import { authorityPolicy, createAuthoritySupervisor } from '../authority/supervisor'
import { createSimulatedOutputWatchdog } from '../authority/watchdog'
import { createRigidBody } from '../controls/physics'
import { createPhysicsSensorFeed } from '../controls/sensors'
import { createEstimator } from '../estimation/estimator'
import { createSimulatedMultirotorController } from '../controls/controller'
import { createMissionEngine, observeMission, missionLimits } from '../missions/engine'
import { exampleMission, validateMission } from '../missions/plan'
export const navigationScenarios = ['avoid-land', 'replan', 'range-loss', 'range-delay', 'position-loss', 'landing-loss', 'rc-override'] as const
export type NavigationScenario = typeof navigationScenarios[number]
/** One owned experiment. The legacy script is selected only by its fixed adapter below. */
function createNavigationRuntime(options: { scenario?: NavigationScenario, seconds?: number }, legacy: boolean, multiple = false, contactProfile?: ContactProfile) {
  if (contactProfile !== undefined && (!multiple || !contactProfiles.includes(contactProfile))) throw new TypeError('Invalid contact profile')
  const scenario = options.scenario ?? 'avoid-land'
  const seconds = options.seconds ?? 70
  if (!navigationScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 8 || seconds > 120) throw new RangeError('Invalid navigation scenario or duration (8..120 seconds)')
  const missionPlan = exampleMission()
  missionPlan.tasks = [
    { id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 12000, next: 'approach' },
    // Two authored legs budget the inflated obstacle detour and settling inside v1's
    // 20-second task limit, independently of which equal-cost side a platform selects.
    { id: 'approach', kind: 'waypoint', positionM: [2.5, -2.5, -1.275], timeoutMs: 20000, next: 'survey' },
    // Author the fixed-origin waypoint at the same height as the declared 1.2 m clearance
    // over the fixture's D=-0.03N plane. Acceptance must not chase a different altitude.
    { id: 'survey', kind: 'waypoint', positionM: [5, 0, -1.35], timeoutMs: 20000, next: 'return' },
    { id: 'return', kind: 'return', timeoutMs: 20000, next: 'land' },
    { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 12000 },
  ]
  missionPlan.rallyM = [0, 0, -1.2]
  const { plan, worstCaseMs, requiredWh } = validateMission(missionPlan)
  // The sensor fixture has this geodetic world origin. Other plans remain valid for policy replay only.
  if (plan.origin.latitudeDeg !== 0 || plan.origin.longitudeDeg !== 0 || plan.origin.ellipsoidHeightM !== 100) throw new TypeError('Physics fixture requires origin 0,0,100 WGS84 ellipsoid')
  let engine = createMissionEngine(plan)
  const supervisor = createAuthoritySupervisor({ sessionId: 123n, bootId: 55n })
  const board = createSimulatedOutputWatchdog({ sessionId: 123n, bootId: 55n })
  const body = createRigidBody({ positionM: [0, 0, -0.1], groundDownM: -0.1, groundGradient: [-0.03, 0] })
  const feed = createPhysicsSensorFeed(0)
  const rangeFeed = createNavigationSensorFeed(scenario === 'range-delay' ? 240 : 60)
  let navigator = createNavigator({ fenceRadiusM: plan.fence.radiusM, minDownM: plan.fence.minDownM })
  let rangeMap: NavigationMap | null = null
  let navigation: NavigationDecision = { state: 'released', reason: 'not-started', targetM: null, route: [], marginM: null, perceptionAgeMs: null, mode: 'route', replans: 0, physicalFlightEnabled: false }
  let lastRangeSequence = 0
  let minTruthClearanceM = Infinity
  let maxLatencyMs = 0
  let detectionFault = false
  let navTrace: { atMs: number, navigation: NavigationDecision, positionM: number[], truthPositionM: number[] }[] = []
  const estimator = createEstimator({ origin: plan.origin, gravityCorrection: 'initialization-only' })
  const controller = createSimulatedMultirotorController({ headingAlignment: 'initial-simulation-north' })
  let truth = body.snapshot()
  let estimate = estimator.snapshot(0)
  let sensors = feed.advanceTo(0)
  let command: Motors = [0, 0, 0, 0]
  let mission: MissionSnapshot = engine.snapshot()
  let lastTask = ''
  let lastState = ''
  let transitions: { atMs: number, taskId: string, state: string, reason: string }[] = []
  let path: { atMs: number, estimatedPositionM: number[] | null, truthPositionM: number[], targetM: number[] | null, state: string, taskId: string }[] = []
  let triggers: { atMs: number, taskId: string, channel: string, evidence: 'simulated-event' }[] = []
  // Two unchanged 84-second mission budgets plus 12 seconds of observation room.
  const horizonMs = multiple ? 180000 : seconds * 1000
  type Occurrence = {
    id: string, issuedAtMs: number, decision: 'approve' | 'deny', requestedAtMs: number,
    attemptedAtMs: number | null, startedAtMs: number | null, terminalAtMs: number | null,
    state: 'queued' | 'refused' | 'running' | 'completed' | 'blocked' | 'aborted', reason: string,
    binding: string | null, result: ReturnType<typeof project> | null,
  }
  const occurrences: Occurrence[] = []
  let queuedOccurrence: Occurrence | null = null, currentOccurrence: Occurrence | null = null
  let contactFeed: ReturnType<typeof createContactFeed> | null = null
  let contactContext: (ContactBinding & { origin: string }) | null = null
  let contactPacket: ContactPacket | null = null, contactHost: ContactHostObservation | null = null
  let contactVerification: ContactVerification | null = null, contactMonitoring = false
  const contactOutcomes: { occurrenceId: string, completedAtMs: number, deadlineMs: number, verifiedAtMs: number | null, phase: ContactVerification['phase'], reason: string, alignment: ContactVerification['alignment'] }[] = []
  function retainContactOutcome() {
    if (contactVerification && contactVerification.phase !== 'pending' && !contactOutcomes.some(item => item.occurrenceId === contactVerification!.binding.occurrenceId)) contactOutcomes.push({ occurrenceId: contactVerification.binding.occurrenceId, completedAtMs: contactVerification.completedAtMs, deadlineMs: contactVerification.deadlineMs, verifiedAtMs: contactVerification.verifiedAtMs, phase: contactVerification.phase, reason: contactVerification.reason, alignment: structuredClone(contactVerification.alignment) })
  }
  const counts = { hostUpdates: 0, controllerUpdates: 0, boardAccepts: 0, boardRevokes: 0, nonzeroAcceptedFrames: 0, armAccepted: 0, engageAccepted: 0 }
  let lastTickMs = -4, lastHostAtMs: number | null = null
  // Nominal powered-time proxy only. No idle-current, charge or endurance measurement.
  let usedWh = 0
  let hostAvailable = true, hostUnavailableReason: string | null = null
  const start = { state: 'not-requested' as 'not-requested' | 'queued' | 'started' | 'refused', requestedAtMs: null as number | null, attemptedAtMs: null as number | null, reason: 'awaiting-explicit-start' }
  let terminal: ReturnType<typeof project> | null = null
  let terminalAtMs: number | null = null, terminalPlant: typeof truth | null = null
  const revoke = () => {
    counts.boardRevokes++
    board.revoke()
  }
  function tick(nowMs: number) {
    command = board.tick(nowMs).motorsN
    if (nowMs > (legacy ? 600 : 0)) {
      if (!legacy && (command.some(n => n > 0) || truth.motorsN.some(n => n >= 0.01))) usedWh += plan.power.hoverW * 4 / 3600000
      truth = body.step(command, 0.004)
    }
    if (contactFeed) {
      contactFeed.capture(nowMs, truth)
      contactPacket = contactFeed.advanceTo(nowMs)
    }
    if (!hostAvailable) return
    feed.capture(truth, nowMs, scenario === 'position-loss' && nowMs >= 6000)
    sensors = feed.advanceTo(nowMs)
    estimate = estimator.update(sensors)
    const obstacles = [{ id: 'post', northM: 2.5, eastM: 0, radiusM: 0.25 }, ...(scenario === 'replan' && nowMs >= 5000 ? [{ id: 'second-post', northM: 3.4, eastM: 2.5, radiusM: 0.25 }] : [])]
    for (const obstacle of obstacles) minTruthClearanceM = Math.min(minTruthClearanceM, Math.hypot(truth.positionM[0] - obstacle.northM, truth.positionM[1] - obstacle.eastM) - obstacle.radiusM - 0.3)
    if (estimate.localPosition && estimate.attitude && estimate.health.tilt && estimate.health.localPosition && !(scenario === 'range-loss' && nowMs >= 6000)) {
      const pose: NavigationPose = { reference: `${estimate.bootId}:${Object.values(estimate.resets).join(',')}`, atMs: nowMs, positionM: [...estimate.localPosition.positionM] as [number, number, number], quaternionWxyz: [...estimate.attitude.quaternionWxyz], positionSigmaM: 0.02 }
      rangeFeed.capture(nowMs, truth, pose, { obstacles, groundNorthSlope: -0.03, landingM: [0.1, 0.06, -0.003] }, scenario === 'landing-loss' && mission.taskId === 'land')
    }
    const packet = rangeFeed.advanceTo(nowMs)
    if (packet && packet.packet.sequence !== lastRangeSequence) {
      lastRangeSequence = packet.packet.sequence
      maxLatencyMs = Math.max(maxLatencyMs, packet.packet.receivedAtMs - packet.packet.capturedAtMs)
      try {
        rangeMap = detectNavigationMap(packet.packet, packet.pose)
        maxLatencyMs = Math.max(maxLatencyMs, rangeMap.latencyMs)
      }
      catch {
        rangeMap = null
        detectionFault = true
      }
    }
    if (legacy && nowMs < 600 || nowMs % 20 !== 0) return
    lastHostAtMs = nowMs
    counts.hostUpdates++
    const batteryPercent = 100 - (legacy ? plan.power.hoverW * Math.max(0, nowMs - 600) / 3600000 : usedWh) / plan.power.availableWh * 100
    const runtime = board.snapshot()
    const observation = {
      kind: 'simulation' as const, nowMs, estimate,
      runtime: { bootId: runtime.bootId, capturedAtMs: nowMs, watchdogHealthy: runtime.fault === null },
      rc: { capturedAtMs: nowMs, connected: true, armSwitch: true, override: scenario === 'rc-override' && nowMs >= 5000 },
      interlocks: { capturedAtMs: nowMs, killActive: false, onGround: legacy && nowMs === 600 || truth.groundContact, motorsStopped: truth.motorsN.every(n => n < 0.01) },
      battery: { capturedAtMs: nowMs, remainingPercent: batteryPercent }, link: { capturedAtMs: nowMs, connected: true },
    }
    const send = (action: 'arm' | 'engage' | 'renew' | 'disarm', targetM = mission.targetM) => {
      const s = supervisor.snapshot()
      const decision = supervisor.update(observation, { version: 1, sessionId: s.sessionId, bootId: s.bootId, epoch: s.epoch, sequence: s.sequence + 1, issuedAtMs: nowMs, action, mode: 'position', leaseMs: 100, target: { positionM: targetM ?? [0, 0, 0], yawRad: 0 } })
      if (decision.commandAccepted && action === 'arm') counts.armAccepted++
      if (decision.commandAccepted && action === 'engage') counts.engageAccepted++
      return decision
    }
    supervisor.update(observation)
    if (contactProfile) {
      contactHost = { nowMs, estimate, interlocks: observation.interlocks, authority: supervisor.snapshot(), board: board.snapshot(), map: rangeMap, packet: contactPacket }
      if (contactMonitoring && contactVerification) {
        contactVerification = reduceContactVerification(contactVerification, contactHost)
        retainContactOutcome()
      }
    }
    const control = () => {
      const imuObservation = sensors.sensors.find(s => s.kind === 'imu')?.observation
      const measurement = imuObservation?.value as ImuMeasurement | undefined
      counts.controllerUpdates++
      return controller.step({ kind: 'simulation', enabled: supervisor.snapshot().state === 'autonomous', nowMs, estimate, angularRateRadS: measurement?.angularRateRadS ?? [0, 0, 0], rateCapturedAtMs: imuObservation?.estimatedCaptureMs ?? -Infinity, target: { positionM: supervisor.snapshot().target?.positionM ?? [0, 0, 0], yawRad: 0, issuedAtMs: nowMs } })
    }
    let explicitAction: MissionAction | undefined
    if (multiple && queuedOccurrence) {
      const occurrence = queuedOccurrence
      queuedOccurrence = null
      occurrence.attemptedAtMs = nowMs
      occurrence.state = 'refused'
      const qualification = qualifyOccurrence(nowMs)
      if (nowMs - occurrence.issuedAtMs > authorityPolicy.commandAgeMs) occurrence.reason = 'approval-expired'
      else if (nowMs + worstCaseMs + (contactProfile ? contactModel.windowMs : 0) + 2000 > horizonMs) occurrence.reason = 'insufficient-session-time'
      else if (!qualification.binding || qualification.binding !== occurrence.binding) occurrence.reason = qualification.reason || 'launch-binding-changed'
      else {
        const armed = send('arm')
        occurrence.reason = armed.reason
        if (armed.commandAccepted) {
          const engaged = send('engage', [0, 0, 0])
          occurrence.reason = engaged.reason
          if (engaged.commandAccepted) {
            // Only accepted arm plus engage retires live contact eligibility.
            if (contactProfile) contactMonitoring = false
            // Only now promote the new flight. Physical collaborators/clock/energy remain.
            engine = createMissionEngine(plan)
            navigator = createNavigator({ fenceRadiusM: plan.fence.radiusM, minDownM: plan.fence.minDownM })
            mission = engine.snapshot()
            navigation = { state: 'released', reason: 'not-started', targetM: null, route: [], marginM: null, perceptionAgeMs: null, mode: 'route', replans: 0, physicalFlightEnabled: false }
            navTrace = []
            transitions = []
            path = []
            triggers = []
            minTruthClearanceM = Infinity
            lastTask = ''
            lastState = ''
            terminal = null
            terminalAtMs = null
            terminalPlant = null
            currentOccurrence = occurrence
            occurrence.state = 'running'
            occurrence.startedAtMs = nowMs
            start.state = 'started'
            start.requestedAtMs = occurrence.requestedAtMs
            start.attemptedAtMs = nowMs
            start.reason = engaged.reason
            explicitAction = 'start'
          }
          else {
            send('disarm')
            revoke()
          }
        }
      }
    }
    // This fixture is an explicit operator script. The mission engine never arms itself.
    if (legacy && nowMs === 600) {
      send('arm')
      send('engage', [0, 0, 0])
    }
    if (terminal) {
      if (multiple) control()
      revoke()
      return
    }
    if (!legacy && start.state === 'queued') {
      start.attemptedAtMs = nowMs
      start.state = 'refused'
      if (nowMs - start.requestedAtMs! > authorityPolicy.commandAgeMs) start.reason = 'start-request-expired'
      else {
        const armed = send('arm')
        start.reason = armed.reason
        if (armed.commandAccepted) {
          const engaged = send('engage', [0, 0, 0])
          start.reason = engaged.reason
          if (engaged.commandAccepted) {
            start.state = 'started'
            explicitAction = 'start'
          }
          else {
            send('disarm')
            revoke()
          }
        }
      }
    }
    if (!legacy && mission.state === 'ready' && explicitAction !== 'start') {
      if (multiple) control()
      return
    }
    const missionInput = observeMission({ estimate, authority: supervisor.snapshot().state, batteryPercent, onGround: observation.interlocks.onGround })
    const action: MissionAction | undefined = legacy && nowMs === 600 ? 'start' : explicitAction
    mission = engine.step(missionInput, action)
    const task = plan.tasks.find(t => t.id === mission.taskId)!
    const goal = 'positionM' in task ? task.positionM : plan.rallyM
    const intent: NavigationIntent = task.kind === 'land' ? { mode: 'land', siteId: 'pad', expectedM: [0, 0, 0] } : { mode: task.kind === 'return' ? 'rtl' : 'route', goalM: goal, clearanceM: 1.2 }
    if (['running', 'paused'].includes(mission.state)) navigation = navigator.step(missionInput, rangeMap, intent)
    else navigation = { state: mission.state === 'completed' ? 'released' : 'blocked', reason: navigation?.state === 'blocked' ? navigation.reason : `mission-${mission.state}`, targetM: null, route: [], marginM: null, perceptionAgeMs: null, mode: intent.mode, replans: navigation?.replans ?? 0, physicalFlightEnabled: false }
    if (mission.payload) triggers.push({ atMs: nowMs, ...mission.payload, evidence: 'simulated-event' })
    if ((mission.state === 'running' || mission.state === 'paused') && navigation?.targetM) send('renew', navigation.targetM)
    else {
      send('disarm')
      revoke()
    }
    const output = control()
    const frame = supervisor.gate(output, nowMs)
    if (frame) {
      if (board.accept(frame, nowMs)) {
        counts.boardAccepts++
        if (frame.motorsN.some(n => n > 0)) counts.nonzeroAcceptedFrames++
      }
    }
    else revoke()
    if (navigation && (nowMs % 100 === 0 || navigation.state === 'blocked')) navTrace.push({ atMs: nowMs, navigation, positionM: [...missionInput.positionM], truthPositionM: [...truth.positionM] })
    if (mission.taskId !== lastTask || mission.state !== lastState) {
      transitions.push({ atMs: nowMs, taskId: mission.taskId, state: mission.state, reason: mission.reason })
      lastTask = mission.taskId
      lastState = mission.state
    }
    if (nowMs % 200 === 0 || !['running', 'paused'].includes(mission.state)) path.push({ atMs: nowMs, estimatedPositionM: estimate.localPosition?.positionM ?? null, truthPositionM: [...truth.positionM], targetM: mission.targetM, state: mission.state, taskId: mission.taskId })
    if (!['running', 'paused'].includes(mission.state)) {
      terminal = project()
      terminalAtMs = nowMs
      terminalPlant = truth
      if (currentOccurrence) {
        currentOccurrence.state = mission.state as 'completed' | 'blocked' | 'aborted'
        currentOccurrence.reason = mission.reason
        currentOccurrence.terminalAtMs = nowMs
        currentOccurrence.result = structuredClone(terminal)
        if (contactProfile && contactContext && mission.state === 'completed') {
          contactVerification = initialContactVerification({ ...contactContext, occurrenceId: currentOccurrence.id }, nowMs, contactVerification ?? undefined)
          contactMonitoring = true
        }
      }
    }
  }
  function project() { return { evidence: 'owned-navigation-physics-simulation' as const, physicalFlightEnabled: false, boardOutputsInhibited: true, scenario, mission, navigation, metrics: { minTruthClearanceM, maxLatencyMs, detectionFault, precisionLandingErrorM: Math.hypot(truth.positionM[0] - 0.1, truth.positionM[1] - 0.06) }, navTrace, budget: { worstCaseMs, requiredWh }, transitions, triggers, path, trace: engine.trace(), authority: supervisor.snapshot(), board: board.snapshot(), finalTruthPositionM: truth.positionM } }
  function snapshot() {
    return structuredClone({
      evidence: 'owned-navigation-session-simulation' as const, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const,
      nowMs: Math.max(0, lastTickMs), lifecycle: !hostAvailable ? board.snapshot().fault || hostUnavailableReason === 'invalid-session-clock' ? 'recovery-required' as const : 'host-silent' as const : terminal ? 'terminal' as const : mission.state === 'ready' ? 'waiting' as const : 'running' as const,
      hostAvailable, hostDataStale: !hostAvailable, hostUnavailableReason, lastHostAtMs, start, counts,
      mission, navigation, authority: supervisor.snapshot(), board: board.snapshot(), plant: truth, sensors, estimate, trace: engine.trace(), terminal, terminalAtMs, terminalPlant,
      energy: { usedWh, remainingWh: plan.power.availableWh - usedWh, model: 'nominal-hover-load-while-powered' as const, idleLoadMeasured: false as const, chargingEnabled: false as const },
    })
  }
  function advanceClock(nowMs: number) {
    if (!Number.isSafeInteger(nowMs) || nowMs < Math.max(0, lastTickMs) || nowMs > horizonMs || nowMs % 4 !== 0) {
      endHost('invalid-session-clock')
      throw new RangeError('Navigation session clock must be monotonic, aligned and bounded')
    }
    for (let at = lastTickMs + 4; at <= nowMs; at += 4) {
      lastTickMs = at
      tick(at)
    }
  }
  function advanceTo(nowMs: number) {
    advanceClock(nowMs)
    return snapshot()
  }
  function requestStart() {
    if (!hostAvailable) {
      if (start.state === 'not-requested') {
        start.state = 'refused'
        start.requestedAtMs = Math.max(0, lastTickMs)
        start.reason = 'host-unavailable'
      }
      return { state: 'refused' as const, reason: 'host-unavailable' }
    }
    if (start.state !== 'not-requested') return { state: 'refused' as const, reason: 'start-attempt-consumed' }
    start.requestedAtMs = Math.max(0, lastTickMs)
    if (terminal || start.requestedAtMs + 20 + worstCaseMs + 2000 > seconds * 1000) {
      start.state = 'refused'
      start.reason = 'insufficient-session-time'
      return { state: 'refused' as const, reason: start.reason }
    }
    start.state = 'queued'
    start.reason = 'awaiting-next-host-tick'
    return { state: 'queued' as const, reason: start.reason }
  }
  function qualifyOccurrence(nowMs: number): { binding: string | null, reason: string } {
    const a = supervisor.snapshot(), b = board.snapshot()
    if (!hostAvailable) return { binding: null, reason: 'host-unavailable' }
    if (currentOccurrence && (!terminal || mission.state !== 'completed')) return { binding: null, reason: terminal ? 'recovery-required' : 'occurrence-busy' }
    if (contactProfile && currentOccurrence) {
      if (!contactHost || contactHost.nowMs !== nowMs || a.lastCheckedAtMs !== nowMs) return { binding: null, reason: 'contact-observation-not-current' }
      if (!contactMonitoring || contactVerification?.phase !== 'verified') return { binding: null, reason: contactVerification?.phase === 'recovery-required' ? 'contact-recovery-required' : 'contact-not-verified' }
      const check = contactEligibility({ ...contactHost, nowMs, estimate, map: rangeMap, packet: contactPacket, authority: a, board: b }, contactVerification.binding)
      if (check.reason) return { binding: null, reason: check.reason }
    }
    if (a.state !== 'disarmed' || b.fault !== null || b.motorsN.some(n => n !== 0)) return { binding: null, reason: 'authority-not-neutral' }
    const observation = observeMission({ estimate, authority: a.state, batteryPercent: 100 - usedWh / plan.power.availableWh * 100, onGround: truth.groundContact })
    const takeoff = plan.tasks.find(task => task.id === plan.start)!
    const goal = 'positionM' in takeoff ? takeoff.positionM : plan.rallyM
    if (lastHostAtMs === null || nowMs - lastHostAtMs > authorityPolicy.interlockAgeMs || estimate.nowMs !== nowMs || estimate.bootId !== a.bootId || b.bootId !== a.bootId || !observation.healthy || !truth.groundContact || truth.motorsN.some(n => n >= 0.01) || Math.hypot(...observation.velocityMps) >= 0.3 || Math.hypot(observation.positionM[0] - goal[0], observation.positionM[1] - goal[1]) > missionLimits.acceptanceM || Math.abs(observation.positionM[2]) > 0.2 || observation.batteryPercent < plan.power.reservePercent + requiredWh / plan.power.availableWh * 100) return { binding: null, reason: 'unqualified-launch-observation' }
    if (scenario === 'rc-override' && nowMs >= 5000) return { binding: null, reason: 'rc-override' }
    return { binding: JSON.stringify([plan, scenario, String(a.sessionId), String(a.bootId), observation.reference, observation.origin]), reason: '' }
  }
  function requestOccurrence(input: unknown) {
    let value: { id: string, issuedAtMs: number, decision: 'approve' | 'deny' }
    try {
      if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('Invalid occurrence shape')
      const descriptors = Object.getOwnPropertyDescriptors(input)
      const fields = ['id', 'issuedAtMs', 'decision']
      if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(field => !descriptors[field] || !descriptors[field]!.enumerable || !('value' in descriptors[field]!))) throw new TypeError('Invalid occurrence fields')
      const id = descriptors.id!.value, issuedAtMs = descriptors.issuedAtMs!.value, decision = descriptors.decision!.value
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(id) || !Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 || !['approve', 'deny'].includes(decision)) throw new TypeError('Invalid occurrence values')
      value = { id, issuedAtMs, decision }
    }
    catch {
      endHost('invalid-occurrence-request')
      throw new TypeError('Invalid manual occurrence request')
    }
    if (occurrences.some(item => item.id === value.id)) return { state: 'refused' as const, reason: 'occurrence-consumed' }
    if (occurrences.length >= 2) return { state: 'refused' as const, reason: 'occurrence-capacity' }
    const nowMs = Math.max(0, lastTickMs)
    const item: Occurrence = { id: value.id, issuedAtMs: value.issuedAtMs, decision: value.decision, requestedAtMs: nowMs, attemptedAtMs: null, startedAtMs: null, terminalAtMs: null, state: 'refused', reason: '', binding: null, result: null }
    occurrences.push(item)
    const qualification = qualifyOccurrence(nowMs)
    if (value.decision === 'deny') item.reason = 'operator-denied'
    else if (value.issuedAtMs > nowMs || nowMs - value.issuedAtMs > authorityPolicy.commandAgeMs) item.reason = 'approval-expired-or-future'
    else if (queuedOccurrence) item.reason = 'occurrence-busy'
    else if (!qualification.binding) item.reason = qualification.reason
    else if (nowMs + 20 + worstCaseMs + (contactProfile ? contactModel.windowMs : 0) + 2000 > horizonMs) item.reason = 'insufficient-session-time'
    else {
      if (contactProfile && !contactFeed) {
        contactContext = { vehicleId: 'navigation-vehicle', sessionId: String(supervisor.snapshot().sessionId), bootId: String(estimate.bootId), reference: `${estimate.bootId}:${Object.values(estimate.resets).join(',')}`, origin: JSON.stringify(estimate.localPosition!.origin) }
        contactFeed = createContactFeed(contactProfile, contactContext)
      }
      item.binding = qualification.binding
      item.state = 'queued'
      item.reason = 'awaiting-next-host-tick'
      queuedOccurrence = item
    }
    return { state: item.state as 'queued' | 'refused', reason: item.reason }
  }
  function snapshotOccurrences() {
    const common = { ...snapshot(), horizonMs, occurrences: structuredClone(occurrences) }
    const contact = contactProfile ? structuredClone({ profile: contactProfile, phase: contactMonitoring ? contactVerification!.phase : 'awaiting-completion' as const, source: contactFeed?.snapshot() ?? { nowMs: -1, sequence: 0, queued: 0, latest: null }, hostObservedAtMs: contactHost?.nowMs ?? null, interlocks: contactHost?.interlocks ?? null, verification: contactVerification, outcomes: contactOutcomes, currentEligibility: hostAvailable && contactMonitoring && contactVerification?.phase === 'verified' && contactHost?.nowMs === Math.max(0, lastTickMs) && contactEligibility(contactHost, contactVerification.binding).reason === '' }) : undefined
    return { ...common, ...(contact ? { contact } : {}) }
  }
  function endHost(reason: string) {
    hostAvailable = false
    hostUnavailableReason ??= reason
    if (queuedOccurrence) {
      queuedOccurrence.state = 'refused'
      queuedOccurrence.reason = 'host-unavailable-before-attempt'
      queuedOccurrence = null
    }
    if (start.state === 'queued') {
      start.state = 'refused'
      start.reason = 'host-unavailable-before-attempt'
    }
    // No final host update, controller output, disarm or revoke. Only the board can expire.
    return snapshot()
  }
  return { advanceTo, advanceClock, snapshot, snapshotOccurrences, requestOccurrence, requestStart, stopHost: () => endHost('host-silent'), tick, project, ended: () => terminal !== null }
}
/** Private single-flight experiment, bounded to 120 seconds on an absolute 4 ms clock.
 * Invalid advances permanently end host eligibility; later valid ticks still expire the board.
 * No transport, mutable collaborator, successful recovery or legacy start exception is exposed.
 */
export function createNavigationSession(options: { scenario?: NavigationScenario } = {}) {
  const runtime = createNavigationRuntime({ ...options, seconds: 120 }, false)
  return { advanceTo: runtime.advanceTo, snapshot: runtime.snapshot, requestStart: runtime.requestStart, stopHost: runtime.stopHost }
}
/** Fixed compatibility adapter for the existing public seven-scenario fixture. */
export function runNavigationFixture(options: { scenario?: NavigationScenario, seconds?: number } = {}) {
  const runtime = createNavigationRuntime(options, true)
  for (let at = 0; at <= (options.seconds ?? 70) * 1000; at += 4) {
    runtime.tick(at)
    if (runtime.ended()) break
  }
  return runtime.project()
}

/** Two manual approvals on one retained plant. No schedule, dock, recharge or recovery. */
export function createNavigationOccurrenceSession(options: { scenario?: NavigationScenario, contact?: ContactProfile } = {}) {
  const runtime = createNavigationRuntime({ scenario: options.scenario, seconds: 120 }, false, true, options.contact)
  return {
    requestOccurrence: runtime.requestOccurrence,
    advanceTo(nowMs: number) {
      runtime.advanceClock(nowMs)
      return runtime.snapshotOccurrences()
    },
    stopHost() {
      runtime.stopHost()
      return runtime.snapshotOccurrences()
    },
    snapshot: runtime.snapshotOccurrences,
  }
}
