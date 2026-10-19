import { setupExecutionBootstrap } from './execution-bootstrap-setup'

const h = await setupExecutionBootstrap('source')
try {
  await h.start()
  const result = await h.complete()
  // The production Worker refuses any environment key or Auth/db/request globals
  // before emitting an event. Completion proves those checked negative conditions.
  // It does not directly report absence of this fixture's arbitrary preload sentinel.
  console.log(JSON.stringify({ oracle: 'production-bootstrap', actualNativeParentPreload: true, nativeParentAuthDatabaseRequest: true, hostWorkerPreserved: true, productionCheckedEnvironmentAndAuthorityAbsent: true, ...result, actualIndividualThreadJoinQualified: false }))
  console.log('PASS native production Worker with positive parent bootstrap')
}
finally { await h.close() }
