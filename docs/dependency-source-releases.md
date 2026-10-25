# Dependency source releases

Dependencies must come from maintained source releases. Dependency patches and
edits to installed package files are prohibited. Fix and test the owning source
repository, run its `bun run release:patch` command, then qualify the released
package in this application with a native frozen install.

## Native Stacks exports

Drone consumes [Stacks 0.75.301](https://github.com/stacksjs/stacks/releases/tag/v0.75.301),
released from `fe69e25d5b60c8eb3a9b22e691c350fae1ba0349` with the native
`bun run release:patch` workflow. The
[exact source CI](https://github.com/stacksjs/stacks/actions/runs/40155235120)
and [package release](https://github.com/stacksjs/stacks/actions/runs/40155235514)
passed before adoption. Upgrade with `./buddy upgrade --version 0.75.301`,
then qualify the actual installed versions and frozen locks.

The former source bridges now resolve through these public package exports:

| Export | Application responsibility retained |
|---|---|
| `@stacksjs/cli/process` | The host facade and caller-specific command trust, paths, deadlines, output limits and strict UTF-8 policy |
| `@stacksjs/storage/prepared-completed-artifact-directory` | Private roots, publication authority, fencing and artifact identity |
| `@stacksjs/storage/temporary-workspaces` | Purge scope, namespace admission and mount visibility |
| `@stacksjs/router/json` | Current authorization, body limits, duplicate-key rejection and domain validation |
| `@stacksjs/realtime/stream` | Producer credit, current authority and the exact successfully enqueued view |

The application-owned asynchronous completed-directory writer retains its own
publication protocol. Framework primitives do not grant authority to publish,
delete, fly or operate hardware. Successful local stream enqueue is not remote
receipt. Process-crash tests do not establish physical power-loss durability.

The copied Action qualification runs from a fresh private directory with no
installed dependencies, disabled auto-install and explicit denial of the original
source entry. It checks authorization, enqueue object identity, revocation and
close cleanup. This qualifies the module-loading and stream boundary, not a
sandbox for untrusted code or a physical vehicle. See
[issue #109](https://github.com/stacksjs/drone/issues/109) for adoption evidence.

## Runtime auto-import generator

The native generator uses [bun-plugin-auto-imports 0.4.5](https://github.com/stacksjs/bun-plugin-auto-imports/releases/tag/v0.4.5),
released from `44e816038020dd934bc2324971a91e275b936de9` after
[source fix #1186](https://github.com/stacksjs/bun-plugin-auto-imports/pull/1186).
The owning `bun run release:patch` command created and pushed the release commit
and tag. Its local publication step failed without registry credentials; the
[tag release workflow](https://github.com/stacksjs/bun-plugin-auto-imports/actions/runs/40166776443)
published the package, and
[exact release CI](https://github.com/stacksjs/bun-plugin-auto-imports/actions/runs/40166776197)
passed. The public archive integrity and its recorded source provenance were
checked before adoption.

The generator selects the first registered name consistently across runtime
imports, globals and declarations, including default exports. It comments
collisions in the generated runtime index. Application functions take precedence
over framework defaults by directory order; use explicit imports when distinct
functions share a name. Update the transitive package with native
`bun update bun-plugin-auto-imports`, then regenerate with `./buddy generate`.
Keep the root dependency declarations and maintained TUF archive unchanged.
Generated output and installed package files are never patched by hand.

## Maintained TUF client

The `tuf-js` dependency key points to the immutable
[`@stacksjs/tuf-js` 6.0.1 release archive](https://github.com/stacksjs/tuf-js/releases/tag/sdk-v6.0.1).
The source is maintained in [stacksjs/tuf-js](https://github.com/stacksjs/tuf-js),
with release source commit `40a7992babc29eb99c3ee18290ef7aa438421c08`.
This is a maintained fork of the MIT-licensed upstream client, distinct from the
upstream npm package. Its original license is retained in the installed package
and `licenses/tuf-js.LICENSE` in this repository. The
[SDK source license](https://github.com/stacksjs/tuf-js/blob/sdk-v6.0.1/packages/client/LICENSE)
retains the original attribution.

The release publishes its package archive, `SHA512SUMS` and `source.json`.
Verify the immutable release identity, source commit and archive integrity before
installation. Retain the exact release URL and frozen lockfile. The existing
`tuf-js` import name resolves to the scoped maintained package through that
dependency key. The SDK source repository's CLI and conformance harness use the
scoped name explicitly.

The observer, copied reference time and typed failure contracts are documented
in [runtime updates](runtime-updates.md#maintained-sdk-persistence-seam). Do not
remove their verification or persistence behavior during an upgrade. Qualify
SDK observer cases, enrollment, persistent store/recovery, interrupted updates,
rollback floors and copied standalone CLI campaigns against the actual release.
Do not claim physical firmware deployment from these synthetic tests.

## Documentation engine

BunPress 0.2.25 includes the deployed-path search fix from
[source commit 096004cc6e7b4800bfd1e90993866c9011ca706d](https://github.com/stacksjs/bunpress/commit/096004cc6e7b4800bfd1e90993866c9011ca706d).
Consume the source release rather than editing installed files. The public
search regressions in `tests/unit/docs-search.test.ts`, native documentation
build and actual browser search selection qualify the application integration.

[Issue #108](https://github.com/stacksjs/drone/issues/108) tracks source-release
migration and downstream qualification evidence.
