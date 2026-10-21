import { expect, test } from 'bun:test'
import { settleExecutionDiagnostics } from '../helpers/execution-diagnostics'

test('a pending DOM diagnostic cannot erase an already received server observation', async () => {
  const result = await settleExecutionDiagnostics(Promise.resolve({ available: true, state: 'running' }), new Promise(() => {}))
  expect(result?.server).toEqual({ available: true, state: 'running' })
  expect(result?.dom).toBeNull()
})


test('a pending server diagnostic cannot erase an already received DOM observation', async () => {
  const result = await settleExecutionDiagnostics(new Promise(() => {}), Promise.resolve({ executionPhase: 'completed' }))
  expect(result.dom).toEqual({ executionPhase: 'completed' })
  expect(result.serverStatus).toBe('pending')
  expect(result.domStatus).toBe('fulfilled')
})

test('a rejected arm stays unavailable without discarding the other settled observation', async () => {
  const result = await settleExecutionDiagnostics(Promise.reject(new Error('not logged')), Promise.resolve({ executionPhase: 'running' }))
  expect(result.server).toEqual({ available: false })
  expect(result.dom).toEqual({ executionPhase: 'running' })
  expect(result.serverStatus).toBe('rejected')
  expect(result.domStatus).toBe('fulfilled')
})

test('two stalled arms return explicit unavailability without inventing an observation', async () => {
  const result = await settleExecutionDiagnostics(new Promise(() => {}), new Promise(() => {}))
  expect(result).toEqual({ server: { available: false }, dom: null, serverStatus: 'pending', domStatus: 'pending' })
})

test('a response after the deadline cannot mutate the returned failure observation', async () => {
  let resolveDom!: (value: unknown) => void
  const dom = new Promise(resolve => { resolveDom = resolve })
  const result = await settleExecutionDiagnostics(Promise.resolve({ available: true }), dom)
  resolveDom({ executionPhase: 'completed' })
  await dom
  expect(result.dom).toBeNull()
  expect(result.domStatus).toBe('pending')
  expect(result.serverStatus).toBe('fulfilled')
})
