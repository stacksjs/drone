import { expect, test } from 'bun:test'
import { runPurgeQualificationFixture } from '../helpers/public-safety-purge-fixture'

test('accepted purge preserves owned and unknown bytes across actual root and parent replacement', async () => {
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-namespace-identity', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  for (const kind of ['root-replacement', 'parent-replacement']) expect(stdout).toContain(`PASS actual ${kind} preserves`)
  if (process.platform === 'linux' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST === '1' && process.geteuid?.() === 0) {
    for (const kind of ['root-uid', 'parent-uid']) expect(stdout).toContain(`PASS actual ${kind} preserves`)
  }
  else expect(stdout).toContain('UNQUALIFIED UID drift requires explicit privileged Linux namespace')
}, 180000)
