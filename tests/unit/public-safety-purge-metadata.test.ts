import { expect, test } from 'bun:test'
import { qualifyPurgeMetadata } from '../helpers/public-safety-purge-metadata'

// Public Auth/Gates/functions plus actual awaited Job, SQLite and filesystem expose cleanup/reuse mistakes.
// Historical dates are reconstructed explicitly; host clock, private ownership plans and drivers remain real.
test('accepted purge gates metadata retirement and key reuse on actual receipt completion and expiry', async () => {
  const result = await qualifyPurgeMetadata({ requirePositive: process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST === '1' })
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
  expect(result.stdout).toContain('PASS actual blocked plan keeps original 30 day review deadline')
  if (result.positiveQualified) {
    expect(result.stdout).toContain('PASS actual operator disable after committed file result')
    expect(result.stdout).toContain('PASS actual expired receipt denies current reads')
  }
  else expect(result.stdout).toContain('UNAVAILABLE completed receipt metadata retirement')
  for (const line of result.stdout.split('\n').filter(line => /^(PASS|UNAVAILABLE|UNQUALIFIED)/.test(line))) console.log(line)
}, 180000)
