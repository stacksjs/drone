import { test } from 'bun:test'
import { qualifyPurgeConnectionRetirement } from '../helpers/public-safety-purge-retirement'
// Native retirement is terminal; no same-process availability or GC recovery claim.
test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge refuses native connection retirement after durable arm', async () => {
  await qualifyPurgeConnectionRetirement()
}, 180000)
