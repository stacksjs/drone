# Dependency source releases

Dependencies must come from maintained source releases. Dependency patches and
edits to installed package files are prohibited. Fix and test the owning source
repository, run its `bun run release:patch` command, then qualify the released
package in this application with a native frozen install.

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
