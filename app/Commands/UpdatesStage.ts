import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { firmwareCommandPolicy, firmwarePolicyFlags } from '../../resources/functions/drone/updates/command'
import { stageRuntimeFirmware } from '../../resources/functions/drone/updates/staging'

export default defineCommand({
  name: 'updates:stage <repository>',
  description: 'Verify an offline signed bench image into a new candidate without installing firmware',
  options: { ...firmwarePolicyFlags, '--trusted-root <path>': 'Initial root file enrolled through an independent trusted channel', '--output <path>': 'New exclusive candidate directory' },
  async handle(options, repository) {
    try {
      const policy = firmwareCommandPolicy(options)
      if (typeof options.trustedRoot !== 'string' || typeof options.output !== 'string') throw new Error('Explicit root path and output required')
      await printAsync(JSON.stringify(await stageRuntimeFirmware({ ...policy, repository, trustedRoot: options.trustedRoot, output: options.output })))
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Firmware staging unavailable: invalid trust, rejected image or output failure') }
      catch { /* Preserve exit 1 when the diagnostic pipe also fails. */ }
    }
  },
})
