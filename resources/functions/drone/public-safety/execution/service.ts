import type { ExecutionStatusInput, ExecutionView } from './types'
import type { ExecutionContext } from './policy'
import { exactRecord } from '../access/mutations'
import { checkExecutionAuthority } from './policy'
import { executionOwner } from './state'

export { captureExecutionContext } from './policy'
export async function readIncidentExecution(context: ExecutionContext, input: ExecutionStatusInput): Promise<ExecutionView | null> {
  const body = exactRecord(input, ['scope'])
  await checkExecutionAuthority(context, body.scope as string)
  const owner = executionOwner()
  if (owner.slot !== null) throw new Error('Execution slot is incompatible')
  return null
}
