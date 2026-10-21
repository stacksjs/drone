import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { firmwareCommandPolicy, firmwarePolicyFlags } from '../../resources/functions/drone/updates/command'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'

export default defineCommand({
  name: 'updates:enroll',
  description: 'Preserve an independently trusted initial root and explicit policy without refreshing or installing firmware',
  options: { ...firmwarePolicyFlags, '--trusted-root <path>': 'Independently authenticated initial root file', '--output <path>': 'New exclusive protected enrollment directory' },
  async handle(options) {
    try {
      const policy = firmwareCommandPolicy(options)
      if (typeof options.trustedRoot !== 'string' || typeof options.output !== 'string') throw new Error('Explicit root path and output required')
      await printAsync(JSON.stringify(enrollRuntimeTrust({ ...policy, trustedRoot: options.trustedRoot, output: options.output })))
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Runtime trust enrollment unavailable: invalid anchor, policy or output failure') }
      catch { /* Preserve exit 1 when the diagnostic pipe also fails. */ }
    }
  },
})
