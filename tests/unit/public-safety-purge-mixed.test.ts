import { expect, test } from 'bun:test'
import { runPurgeQualificationFixture } from '../helpers/public-safety-purge-fixture'

test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge binds mixed public changes and freezes each ordinary writer', async () => {
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-mixed', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain('PASS actual mixed public source records member hold managed changes')
  expect(stdout).toContain('PASS actual canonical reordered duplicate retry')
}, 180000)
