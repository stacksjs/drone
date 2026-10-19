# Native realtime stream compatibility

This temporary module carries the reviewed Stacks native stream implementation from [commit 3da3b9a](https://github.com/stacksjs/stacks/commit/3da3b9a19c207760786993d3d47412e954f2045f). Upstream source SHA256:

```text
85ba655c7a6ec3090bd02da7b747c9cceafbdbcf51987d982f51f2b370b0e8b9
```

The installed realtime0.75.221 package lacks enqueue and close observations. Only the server-instance import changes, pointing to that installed package so this stream uses its existing hub and emit path. The wire implementation is otherwise identical, under the repository's MIT license. No dependency tree is patched.

The execution adapter grants private producer credit after an exact view's successful native enqueue. This proves local bounded buffering, without implying remote receipt. Connected and heartbeat metadata are null and cannot acknowledge an application view. Native close rejects pending delivery and releases the subscriber. The adapter still checks current authority before forwarding each opaque chunk.

Remove this directory when an adopted native realtime package provides the reviewed API and passes the same application tests. Change the adapter import back to the native export and run the source-pin/transport, actual copied Action artifact and native HTTP capacity/lifecycle/limits tests. A source publication alone does not upgrade the installed package. The artifact fixture qualifies bounded transport packaging with native build options; it does not qualify a complete authenticated bundled server or Docker image.

```sh
bun --no-env-file test tests/unit/public-safety-execution-native-stream.test.ts
bun --no-env-file test tests/unit/public-safety-execution-http.test.ts
bun --no-env-file test tests/unit/public-safety-execution-http-limits.test.ts
```
