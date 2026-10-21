import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { prepareRuntimeFirmwareUpdate } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:prepare <directory>',
  description: 'Authenticate a signed image under protected metadata into a new candidate without installing firmware',
  options: { ...storeReferenceFlags, '--repository <path>': 'Bounded offline signed-image repository', '--output <path>': 'New exclusive candidate directory', '--trusted-system-clock-source <name>': 'Audit label for the independently managed trusted system clock, not an attestation' },
  async handle(options, directory) {
    try {
      if (typeof options.repository !== 'string' || typeof options.output !== 'string' || typeof options.trustedSystemClockSource !== 'string') throw new Error('Explicit repository, output and independently trusted system-clock source required')
      await printAsync(JSON.stringify(await prepareRuntimeFirmwareUpdate({ ...storeCommandReference(options, directory), repository: options.repository, output: options.output, clock: { source: options.trustedSystemClockSource, read: () => new Date() } })))
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Runtime image preparation unavailable: invalid trust, clock, rejected image or output failure') }
      catch { /* Preserve failure when the diagnostic pipe also fails. */ }
    }
  },
})
