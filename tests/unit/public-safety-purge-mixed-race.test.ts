import { test } from 'bun:test'
import { qualifyPurgeMixedFreezeRace } from '../helpers/public-safety-purge-mixed-race'

test('accepted purge holds real SQLite authority against six concurrent native public writers', async () => {
  await qualifyPurgeMixedFreezeRace()
}, 180000)
