import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { firmwareCommandPolicy, firmwarePolicyFlags } from '../../resources/functions/drone/updates/command'
import { inspectStagedRuntimeFirmware } from '../../resources/functions/drone/updates/staging'

export default defineCommand({
  name: 'updates:inspect <directory>',
  description: 'Re-authenticate a staged bench image against explicit trust and compatibility policy',
  options: firmwarePolicyFlags,
  async handle(options, directory) {
    try { await printAsync(JSON.stringify(await inspectStagedRuntimeFirmware({ ...firmwareCommandPolicy(options), directory }))) }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Firmware candidate unavailable: invalid trust, rejected image or output failure') }
      catch { /* Preserve exit 1 when the diagnostic pipe also fails. */ }
    }
  },
})
