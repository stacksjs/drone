import { Action } from '@stacksjs/actions'
import { startExecutionHttp } from '../../resources/functions/drone/public-safety/execution/http'

export default new Action({
  name: 'PublicSafetyExecutionStart',
  method: 'POST',
  handle: request => {
    const action = new URL(import.meta.url)
    if (!/\.(?:ts|js)$/.test(action.pathname)) throw new Error('Owned execution Action entrypoint is unavailable')
    const extension = action.pathname.endsWith('.ts') ? 'ts' : 'js'
    return startExecutionHttp(request, new URL(`../Workers/PublicSafetySimulation.${extension}`, action))
  },
})
