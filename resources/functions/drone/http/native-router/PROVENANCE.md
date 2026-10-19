# Published native JSON parser bridge

json.ts is a byte-for-byte copy of storage/framework/core/router/src/json.ts
from stacksjs/stacks main commit b3184eba2f073159d1ba8074a581ab51b3c63cc8.
The implementation was introduced at446a724da8a71cb9a7dc15900889b6c55ad368c1.

SHA-256:15af53bdee71a028aa630b6e47338ea391bc24cd7fe70e50d4b7b0e9ba240958.

Drone's installed @stacksjs/router0.75.221 does not export this helper. Installed
packages and dependency versions remain unchanged. Replace this explicit bridge
with the normal @stacksjs/router/json export after a qualified native release.

Native qualification includes duplicate-key RED/GREEN,862 router tests,567
application tests, native types and lint, package JS/declaration builds, and real
root/json/body export runtime and TypeScript consumers. Both independent source
review axes pass. Exact published CI is tracked separately; these local results
do not claim a completed CI run or deployment. The source is MIT licensed; the
original license is preserved beside this file.

This parser validates already-decoded JSON and optionally refuses duplicate
object keys. It supplies no authentication, authorization, body byte limit,
UTF-8 decoding or application schema. Handover retains native bounded body reads,
current Auth/Gates and exact domain validation around it.
