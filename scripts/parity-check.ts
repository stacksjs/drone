import inventory from '../docs/roadmap/upstream-inventory.json'
import issues from '../docs/roadmap/issues.json'
import audit from '../docs/parity-audit.json'
import { checkParityAudit, runParityEvidence } from './parity'
import type { ParityAudit } from './parity'
import { compareUpstreamSnapshot, verifyParitySources, verifyParityIssueLinks } from './parity-refresh'

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    let execute = false, requireComplete = false, verifySources = false, verifyLinks = false, snapshotPath: string | undefined
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--run-evidence') execute = true
      else if (args[i] === '--verify-links') verifyLinks = true
      else if (args[i] === '--verify-sources') verifySources = true
      else if (args[i] === '--require-complete') requireComplete = true
      else if (args[i] === '--snapshot') { snapshotPath = args[++i]; if (!snapshotPath) throw new Error('Missing snapshot path') }
      else throw new Error(`Unknown argument: ${args[i]}`)
    }
    const report = checkParityAudit(inventory, issues, audit as ParityAudit)
    const upstream = snapshotPath ? compareUpstreamSnapshot(inventory, audit as ParityAudit, await Bun.file(snapshotPath).json()) : null
    const linkErrors = verifyLinks && report.validAudit ? await verifyParityIssueLinks(issues) : null
    const sourceErrors = verifySources && report.validAudit ? await verifyParitySources(audit as ParityAudit, inventory) : null
    const evidence = execute && report.validAudit ? await runParityEvidence(audit as ParityAudit) : null
    console.log(JSON.stringify({ ...report, evidenceExecuted: !!evidence, execution: evidence ? { at: new Date().toISOString(), bun: Bun.version, platform: process.platform, architecture: process.arch } : null, evidence, sourceErrors, linkErrors, upstream }, null, 2))
    process.exitCode = !report.validAudit || linkErrors?.length || sourceErrors?.length || (requireComplete && !report.parityComplete) || evidence?.some(e => !e.passed) || upstream?.reviewRequired ? 1 : 0
  }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
