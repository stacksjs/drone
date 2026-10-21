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
transactional or implement a protected trust store.

Bun applies the patch through root `patchedDependencies` and the lockfile.
Always prepare with `bun patch tuf-js@6.0.0` before editing an installed package,
then generate changes with `bun patch --commit tuf-js@6.0.0`. Do not edit shared
package caches. For upgrades, review the upstream change against every patch
hunk and rerun the SDK observer cases, update/enrollment regressions, clean
frozen installation and copied standalone CLI qualification. Never silently
carry a patch onto another version.

See `docs/runtime-updates.md` for the trust and clock limits. The extensions are
maintained here and are not claimed to be unmodified upstream options.
