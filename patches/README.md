# Maintained dependency patches

## tuf-js 6.0.0

`tuf-js@6.0.0.patch` applies to the npm 6.0.0 release from
[the TUF JavaScript client](https://github.com/theupdateframework/tuf-js), upstream
commit `c30653d07f0c41fbe5a2030d25eca6fd04f8547f`. The original MIT copyright and permission
notice is retained in `tuf-js.LICENSE` and in the installed package.

The patch adds an awaited, copy-owning `onVerifiedMetadata` observer before the
SDK writes each newly verified remote metadata file, plus an owned finite
`referenceTime` for recovery replay. Default callers keep upstream verification rules and the current fixed start
time. Persistence failure aborts rather than being interpreted as a missing
remote root or a cache miss under `forceCache`. Discard failed updater instances;
their in-memory trust set is not rolled back. It does not make cache writes
transactional or implement a protected trust store. Public operational error
exports retain causes and identify remote verification, persistence and download
phases. Verification errors identify an attempted role, not permission to discard
state. Classify persistence first, including when an observer throws a
verification error; unknown causes require maintenance rather than an assumed
invalid-input verdict.
Wrapper messages never coerce caught values, so opaque observer rejections keep
their persistence classification and exact cause under cache-preferred refresh.

Bun applies the patch through root `patchedDependencies` and the lockfile.
Always prepare with `bun patch tuf-js@6.0.0` before editing an installed package,
then generate changes with `bun patch --commit tuf-js@6.0.0`. Do not edit shared
package caches. Exclude empty generated `.bun-tag-*` entries from the patch;
they are installer cache markers rather than package source. For upgrades, review the upstream change against every patch
hunk and rerun the SDK observer cases, update/enrollment regressions, clean
frozen installation and copied standalone CLI qualification. Never silently
carry a patch onto another version.

See `docs/runtime-updates.md` for the trust and clock limits. The extensions are
maintained here and are not claimed to be unmodified upstream options.

## BunPress 0.2.22

`@stacksjs%2Fbunpress@0.2.22.patch` keeps generated local search results under
BunPress's configured deployment path. The native page renderer already uses
`/docs`, but 0.2.22's search index contained origin-root paths, so selecting a
result navigated to a 404. The patch applies the same base-path resolution after
locale translation and fallback selection, preserving anchors and root-hosted
sites. A real source directory named `docs` still receives the deployment prefix.

The patch changes the native index builder and adds a small helper matching the renderer's path resolution;
it adds no browser redirect or application search implementation. The installed
package retains BunPress's MIT license. Regression coverage lives in
`tests/unit/docs-search.test.ts`. Rebuild native docs and verify an actual search
selection after upgrading or removing this patch. Prepare installed changes with
`bun patch @stacksjs/bunpress@0.2.22` and retain the generated Bun patch and lockfile.

The shared engine fix is [BunPress PR 91](https://github.com/stacksjs/bunpress/pull/91),
source commit `096004cc6e7b4800bfd1e90993866c9011ca706d`. Remove the compatibility
patch only after upgrading to a release that includes it and repeating the checks.
