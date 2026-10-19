import { beforeAll, expect, test } from 'bun:test'
import type { AgricultureRun, LivestockObservation, LivestockObservationInput } from '../../resources/functions/drone/agriculture/types'
import { readFileSync } from 'node:fs'
import { createLivestockObservation } from '../../resources/functions/drone/agriculture/evidence'
import { processAgriculture } from '../../resources/functions/drone/agriculture/layer'
import { agricultureImagePreview, agricultureLayerPreview } from '../../resources/functions/drone/agriculture/presentation'
import { calibrateAgricultureImage } from '../../resources/functions/drone/agriculture/radiometry'
import { agricultureScenarios, simulateAgriculture } from '../../resources/functions/drone/agriculture/runtime'

interface Signal<T> { (): T, set(value: T): void, update(change: (value: T) => T): void }
function state<T>(initial: T): Signal<T> {
  let value = initial
  const signal = () => value
  signal.set = (next: T) => { value = next }
  signal.update = (change: (previous: T) => T) => { value = change(value) }
  return signal
}
interface Workspace {
  run: Signal<AgricultureRun | null>
  captureId: Signal<string>
  binding: Signal<boolean>
  error: Signal<string>
  animalId: Signal<string>
  observerId: Signal<string>
  pixelX: Signal<number>
  pixelY: Signal<number>
  note: Signal<string>
  observations: Signal<LivestockObservation[]>
  observeAnimal(): Promise<void>
  clear(): void
  execute(): void
}
interface Request { input: LivestockObservationInput, complete(): Promise<LivestockObservation>, reject(error: Error): void }
let baseline: AgricultureRun
beforeAll(() => { baseline = simulateAgriculture() })

// Actual-source action harness: execute the component's TypeScript script and
// real observation service, with callable signal/lifecycle stand-ins and a
// controlled response gate. This tests handler ownership across await, not
// compiled STX delivery, DOM reactivity or browser cryptography. No browser
// crypto/runtime patch or alternate copy of the handler is used.
function workspace() {
  const requests: Request[] = []
  function controlledObservation(run: AgricultureRun, input: LivestockObservationInput) {
    // The real service starts immediately and takes its normal bounded snapshot.
    // Only delivery of its completed response is controlled by this harness.
    const result = createLivestockObservation(run, input).then(value => ({ value }), error => ({ error }))
    let resolve!: (value: LivestockObservation) => void, reject!: (error: Error) => void
    const promise = new Promise<LivestockObservation>((yes, no) => { resolve = yes; reject = no })
    requests.push({ input, reject, async complete() {
      const settled = await result
      if ('error' in settled) { reject(settled.error); throw settled.error }
      resolve(settled.value)
      return settled.value
    } })
    return promise
  }
  const source = readFileSync(new URL('../../resources/components/AgricultureWorkspace.stx', import.meta.url), 'utf8')
  const script = source.match(/<script client>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('Agriculture workspace client script is unavailable')
  const body = script.replace(/^import .+ from '[^']+'\s*$/gm, '')
  if (/^import\s/m.test(body)) throw new Error('Workspace action harness requires import binding support')
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(body)
  const dependencies = {
    state, derived: <T>(read: () => T) => read,
    effect: () => {}, onDestroy: () => {},
    useTimeout: (callback: () => void) => ({ start: callback, stop() {} }),
    agricultureScenarios, simulateAgriculture, processAgriculture, calibrateAgricultureImage,
    createLivestockObservation: controlledObservation, agricultureImagePreview, agricultureLayerPreview,
  }
  const actions = new Function(...Object.keys(dependencies), `${compiled}\nreturn { run, captureId, binding, error, animalId, observerId, pixelX, pixelY, note, observations, observeAnimal, clear, execute }`)(...Object.values(dependencies)) as Workspace
  actions.run.set(baseline); actions.captureId.set('photo-0009')
  draft(actions, 'animal-a', 'Submitted animal A note.')
  return { actions, requests }
}
function draft(actions: Workspace, animal: string, note: string) {
  actions.animalId.set(animal); actions.observerId.set('operator-chris')
  actions.pixelX.set(48); actions.pixelY.set(36); actions.note.set(note)
}

test('completion retains original capture A while preserving a new capture B draft', async () => {
  const { actions, requests } = workspace(), pending = actions.observeAnimal()
  expect(actions.binding()).toBe(true)
  expect(requests[0]!.input.captureId).toBe('photo-0009')
  actions.captureId.set('photo-0010'); draft(actions, 'animal-b', 'New capture B draft.')
  await requests[0]!.complete(); await pending
  expect(actions.observations()).toHaveLength(1)
  expect(actions.observations()[0]!.captureId).toBe('photo-0009')
  expect(actions.observations()[0]!.animalId).toBe('animal-a')
  expect(actions.note()).toBe('New capture B draft.')
  expect(actions.animalId()).toBe('animal-b')
  expect(actions.binding()).toBe(false)
})

test('completion preserves edited same-capture drafts when any submitted field changes', async () => {
  const edits: ((actions: Workspace) => void)[] = [
    actions => actions.note.set('Edited same-capture note.'),
    actions => actions.animalId.set('animal-edited'),
    actions => actions.observerId.set('observer-edited'),
    actions => actions.pixelX.set(49),
    actions => actions.pixelY.set(37),
  ]
  for (const edit of edits) {
    const { actions, requests } = workspace(), pending = actions.observeAnimal()
    edit(actions)
    const expected = actions.note()
    await requests[0]!.complete(); await pending
    expect(actions.note()).toBe(expected)
    expect(actions.observations()[0]!.note).toBe('Submitted animal A note.')
    expect(actions.binding()).toBe(false)
  }
})

test('completion clears the unchanged submitted note after retaining its original source-bound record', async () => {
  const { actions, requests } = workspace(), pending = actions.observeAnimal()
  const actual = await requests[0]!.complete(); await pending
  expect(actions.note()).toBe('')
  expect(actions.observations()).toEqual([actual])
  expect(actual.captureId).toBe('photo-0009')
  expect(actual.physicalAnimalVerified).toBe(false)
})

test('clear discards stale completion without appending it or releasing a new run binding', async () => {
  const { actions, requests } = workspace(), oldPending = actions.observeAnimal()
  actions.clear()
  expect(actions.observations()).toEqual([])
  expect(actions.binding()).toBe(false)
  actions.execute()
  actions.captureId.set('photo-0009'); draft(actions, 'new-run-animal', 'New run draft.')
  const newPending = actions.observeAnimal()
  expect(requests).toHaveLength(2)
  expect(actions.binding()).toBe(true)
  await requests[0]!.complete(); await oldPending
  expect(actions.observations()).toEqual([])
  expect(actions.binding()).toBe(true)
  expect(actions.note()).toBe('New run draft.')
  const actual = await requests[1]!.complete(); await newPending
  expect(actions.observations()).toEqual([actual])
  expect(actions.binding()).toBe(false)
  expect(actions.note()).toBe('')
})

test('rejection preserves changed notes and a cleared epoch suppresses stale errors', async () => {
  const { actions, requests } = workspace(), pending = actions.observeAnimal()
  actions.note.set('Keep this changed note.')
  requests[0]!.reject(new Error('Controlled observation rejection')); await pending
  expect(actions.note()).toBe('Keep this changed note.')
  expect(actions.observations()).toEqual([])
  expect(actions.error()).toBe('Controlled observation rejection')
  expect(actions.binding()).toBe(false)
  const stale = actions.observeAnimal()
  actions.clear(); actions.note.set('New epoch note.')
  requests[1]!.reject(new Error('Stale rejection')); await stale
  expect(actions.error()).toBe('')
  expect(actions.note()).toBe('New epoch note.')
  expect(actions.observations()).toEqual([])
})
