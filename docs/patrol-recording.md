# Finite patrol recording and replay

The optional patrol dataset retains the normalized decisions and exact compact summary from one fresh 180 second simulated experiment. Replay runs the same fixed model again and compares that summary byte for byte.

```sh
./buddy patrol:simulate --output /tmp/patrol-neutral
./buddy patrol:replay /tmp/patrol-neutral
./buddy patrol:simulate --decisions examples/patrol-decisions.json --unsigned-local-review --enable-charge --output /tmp/patrol-approved
./buddy patrol:replay /tmp/patrol-approved --unsigned-local-review --enable-charge
```

A new output directory contains `recording.json`, `summary.json` and `manifest.json`. The recording stores the actual supported Bun version, normalized input and summary digest. The manifest covers the exact UTF-8 bytes and lengths of both required files. Recording and manifest each allow 4096 bytes including their newline; the summary allows 16384 bytes. Publication uses the existing exclusive private-directory helper, synced files and directory entries, and a manifest linked after those files. Existing targets are never overwritten or cleaned up automatically. Parents must remain operator controlled.

Replay accepts only the fixed format and model profile. The recording format recognizes Bun 1.4.2, 1.4.3 and 1.4.4, but a recording must use exactly the version running replay. The application requires Bun 1.4.4. The version is actual runtime metadata. The `./buddy` launcher prefers the project's installed Pantry Bun before PATH, so changing the global executable may leave Buddy on the local version. A compiled `drone` binary uses its embedded Bun version; a different global Bun installation does not change that identity. It is not binary provenance or a promise of identical results across platforms. Any differing retained summary byte fails comparison.

Replay requires fresh `--unsigned-local-review` for any recorded decision and fresh `--enable-charge` for any charge decision, including denial. Stored flags never provide fresh consent. Empty decision lists can replay neutrally without those flags. These local opt-ins are unsigned metadata, without authenticated operator identity or durable authority grants.

The dataset has no raw trace, intermediate epochs or restored runtime state. Verified replay means the new model produced the same compact summary. A matching failed model can be verified while still exiting with status 1. Neutral previews, fulfilled denials and completed experiments exit successfully when verification matches. Invalid input, incomplete files, digest mismatch, unsupported engine, absent consent, differing results and output failures exit nonzero.

A visible valid manifest with both matching files is readable even if the pending marker remains. A missing manifest is incomplete. This is an observed file-consistency rule, without proof that publication returned or survived power loss. An error after linking the manifest or writing stdout can leave a complete dataset. Inspect it explicitly; do not assume absence or retry into the same directory.

Hashes do not authenticate a malicious same-user replacement. Reads are bounded to the three fixed names and reject final symlink directories and nonregular files. Separate file reads are not an atomic filesystem snapshot. This work does not add unattended scheduling, restart/resume, physical control or charging qualification. Issue #24 remains open.
