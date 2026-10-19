import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'

export default defineCommand({
  name: 'public-safety:access <user-id>',
  description: 'Grant local native incident access and save a short-lived token privately for an existing account',
  options: {
    '--mode <name>': { description: 'read or coordinate; incident membership still governs every request', default: 'read' },
    '--create-incidents': { description: 'Explicit platform permission to create incidents, requires coordinate mode', default: false },
    '--minutes <n>': { description: 'Token lifetime in whole minutes, 1..60', default: '30' },
    '--output <directory>': 'Required new private directory for token.json',
  },
  async handle(options, userId) {
    try {
      if (!/^\d+$/.test(userId) || !/^\d+$/.test(options.minutes) || !options.output) throw new TypeError('Provide a numeric user ID, whole token minutes and --output')
      // Buddy has already selected this application and its database. Keep native ORM/auth
      // discovery out of the standalone simulator binary and browser entrypoints.
      const { provisionIncidentAccess } = await import('../../resources/functions/drone/public-safety/access/provision')
      const report = await provisionIncidentAccess({ userId: Number(userId), mode: options.mode as 'read' | 'coordinate', createIncidents: options.createIncidents, minutes: Number(options.minutes), output: options.output })
      print(JSON.stringify(report, null, 2))
    }
    catch (error) { printError(error instanceof TypeError ? error.message : 'Incident access provisioning failed'); process.exitCode = 1 }
  },
})
