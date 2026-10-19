# Explicit published Stacks source bridge

The two TypeScript modules in this directory are byte-for-byte copies from
stacksjs/stacks commit 8c16debe212da132bb5c7322548a9daaa1c88c0f,
storage/framework/core/storage/src/. Native implementation: 627a59acee.

The npm registry reported @stacksjs/storage 0.75.230 when adopted. The published
source contribution is not available from Drone's installed 0.75.221 export.
No installed package or dependency version is changed. Replace this explicit
bridge with the normal package export after a qualified native release.

SHA-256:

- completed-artifact-directory.ts: 508f78a2897b0ad01e1635eb07bf63ac3598f823934a37668bdbb8ae51a3b9b4
- prepared-completed-artifact-directory.ts: f7b41c08f7c29284b19b2d9fed136c16384c44c32a85576de79070c30ad74e71

The established app completed-directory.ts and asynchronous offline writer
remain unchanged. Managed publication uses only the prepared synchronous
interface. This bridge grants no filesystem ownership, authorization, SQL
fencing, power-loss durability or deletion policy by itself.
