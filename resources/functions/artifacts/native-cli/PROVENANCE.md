# Explicit Stacks CLI source bridge

`process.ts` is a byte-for-byte copy from Stacks commit
[3c52a79013df2e8026e4b364dfb9589eaf11375c](https://github.com/stacksjs/stacks/blob/3c52a79013df2e8026e4b364dfb9589eaf11375c/storage/framework/core/cli/src/process.ts),
under the upstream [MIT licence](https://github.com/stacksjs/stacks/blob/3c52a79013df2e8026e4b364dfb9589eaf11375c/LICENSE.md).
SHA-256: `33112ca2c6f9e576ec758d94108473ac522e17d9958067de0a9a932b5e5d4174`.

Drone's installed `@stacksjs/cli` 0.75.221 does not expose this module. No
installed package, dependency range or lockfile is changed. Replace this explicit
bridge with `@stacksjs/cli/process` after a packaged release is qualified here.
The source contribution is tracked in Stacks PRs #2970 and #2972; their main and
CI states are retained separately in the implementation evidence.

The app facade retains the existing `runBoundedHostProcess` name. Git inspection,
parity tooling, portable qualification and local build commands use the native
finite process implementation. Callers retain their own trust, path, output and
time policies. Process cleanup does not establish signed-image authority, board
health, hardware installation or physical commissioning.
