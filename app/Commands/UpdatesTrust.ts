import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { inspectRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'

export default defineCommand({
  name: 'updates:trust <directory>',
  description: 'Verify an initial trust enrollment against its independently retained record hash',
  options: { '--enrollment-sha256 <hex>': 'Independently retained SHA-256 from trusted enrollment' },
  async handle(options, directory) {
    try {
      if (typeof options.enrollmentSha256 !== 'string') throw new Error('An independently retained enrollment pin is required')
      await printAsync(JSON.stringify(inspectRuntimeTrust({ directory, enrollmentSha256: options.enrollmentSha256 })))
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Runtime trust unavailable: invalid enrollment pin or protected state') }
      catch { /* Preserve exit 1 when the diagnostic pipe also fails. */ }
    }
  },
})
