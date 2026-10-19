# Managed dataset resource qualification

This is a source derivation for the current qualified encoder/runtime, The existing managed 32 MiB check still includes the manifest. Under the pinned current profile an admissible source cannot reach that check's numerical boundary because a tighter bound applies first.

## Source pixels constrain derivative size

Let S be the canonical UTF-8 source size, C the accepted capture count and N the sum of capture width*height across those captures.

- [`evidence.ts`](../resources/functions/drone/public-safety/evidence.ts) publicSafetyRecordingData permits S<=16,777,216. `validatePublicSafetyRun` requires exact deterministic replay, so arbitrary short/fabricated image arrays are not admissible.
- [`mapping/runtime.ts`](../resources/functions/drone/mapping/runtime.ts) limits accepted captures to 256 and generates fixed `photo-0001` IDs. [`camera.ts`](../resources/functions/drone/public-safety/camera.ts) renders one Uint8 RGBA plane, one Uint16 thermal plane and one Uint8 support plane of width*height. It sets every alpha byte 255 before ray/privacy decisions. [`runtime.ts`](../resources/functions/drone/public-safety/runtime.ts) joins each accepted visible frame to exactly one numeric capture.
- In canonical source, the visible RGBA array alone needs at least 10N+C ASCII bytes: at least 6N decimal digits (three RGB values each at least one digit, plus three-digit 255 alpha), 4N-C commas and 2C brackets. Thermal and support each need at least 2N+C (one digit, commas, brackets). Thus S>=14N+3C, even ignoring every other field and any duplicate planes.
- Consequently N<=floor(16,777,216/14)=1,198,372. The separate source node budget tightens this further, but is unnecessary for this conservative proof.
- [`planner.ts`](../resources/functions/drone/public-safety/planner.ts) requires width >= 16. Therefore total row count H<=N/16. All filtered PNG bytes U=4N+H are <=4N+ceil(N/16)=4,868,387.

## Exact installed PNG path and compression bound

`ts-images@0.2.31`'s actual PNG encoder in `dist/chunk-5z5cky6h.js` calls the embedded `dist/chunk-8edz5tfp.js`, not the independently installed @stacksjs/ts-png module. It supplies only width, height, RGBA bytes and deflateLevel 9. The embedded implementation uses 8-bit RGBA, a single filter byte per row, node:zlib deflateSync with strategy 3, no gamma/dictionary/custom metadata, and exactly one IHDR, IDAT and IEND chunk. PNG framing contributes 57 bytes per image.

Qualified Bun 1.4.3 reports zlib commit 12731092979c6d07f42da27da673a9f6c7b13586. Its pinned [build source](https://github.com/oven-sh/bun/blob/c6da4a4d3/scripts/build/deps/zlib.ts) identifies that exact zlib-ng commit, and its [native binding](https://github.com/oven-sh/bun/blob/c6da4a4d3/src/runtime/node/zlib/NativeZlib.rs) calls deflate. [node:zlib defaults and sync processing](https://github.com/oven-sh/bun/blob/c6da4a4d3/src/js/node/zlib.ts) use default window/memory settings and Z_FINISH; no custom flush is supplied here.

The exact [zlib-ng deflateBound implementation](https://github.com/zlib-ng/zlib-ng/blob/12731092979c6d07f42da27da673a9f6c7b13586/deflate.c#L604) supplies the conservative compressed bound u+ceil(u/8)+ceil(u/64)+11 for a zlib-wrapped stream, broader than the default-parameter bound. These qualified arm64/x64 builds do not use the IBM DFLTCC hook. Summing per-image rounding generously adds at most 2C. Including PNG framing, all PNGs are bounded by U+ceil(U/8)+ceil(U/64)+70C, which is 5,570,925 bytes at the independent maxima U=4,868,387 and C=256. Thermal/support add exactly 3N=3,595,116 bytes.

These are valid worst-size bounds of the actual encoder path, not a claim that compression ratio is favorable on the sampled scene.

## Other managed bytes, including manifest

The recording file is S+1 for its newline. README is a fixed 1205-byte literal in the pinned renderer; allocate a generous 4096 bytes.

The manifest has the exact fixed object shape in [`export.ts`](../resources/functions/drone/public-safety/export.ts), at most 256 image records and 770 data-file records (3C+recording+README; the manifest does not recursively include itself). Image/file strings are generated ASCII paths/IDs or fixed enums/constants, <=256 characters; retention and incident IDs are canonical ASCII <= 64 and expiry exactly 24 characters. SHA strings are 64 ASCII bytes. All manifest quantities are nonnegative safe integers; replacing each with Number.MAX_SAFE_INTEGER dominates its decimal representation. Replacing every other string with 256 unescaped ASCII characters, booleans with false, SHA strings with 64 characters, and arrays with their maximal counts gives 618,273 UTF-8 bytes under the exact pretty JSON shape. The executable proof verifies that shape against an actual valid rendered recording. Allocate a generous 1,048,576 bytes instead. There are no arbitrary notes, config trees, filenames, extra fields or source planes in this manifest.

Therefore all managed files including manifest are bounded by:

    16,777,216 + 1 recording newline
    + 4,096 README allowance
    + 1,048,576 manifest allowance
    + 5,570,925 PNG allowance
    + 3,595,116 thermal/support allowance
    = 26,995,930 bytes

This is 6,558,502 bytes below 33,554,432. Exact 32 MiB and 32 MiB+1 valid managed replays are unreachable for this qualified profile. The production 32 MiB guard is a conservative second guard, not an observed acceptance boundary. The source's exact 16 MiB/+1 canonical boundary and actual 256/257 ACK boundary are separately exercised. The 32 MiB/770-file native benchmark only measures synchronous FS workload; it is not the basis of this proof.

## Reproducibility and scope

Run `bun scripts/qualify-public-safety-managed-budget.ts` from the checkout. The
script renders a real valid collection, verifies the manifest shape and conservative
arithmetic, and asserts the qualified Bun/zlib/ts-images versions and relevant source
hashes. It performs no managed publication or deletion. It is an explicit qualification
command, not a test of invented boundary recordings.

The derivation was independently reviewed and reproduced on Bun 1.4.3. The sampled
recordings and separate native 32 MiB filesystem workload are corroborating evidence;
they do not establish the bound above. Future encoder, runtime or profile changes must
re-establish the proof or qualify a reachable managed boundary before updating the
script's assertions. The production byte guard continues to enforce its declared cap.
No hardware, power-loss or blocking-time guarantee follows.
