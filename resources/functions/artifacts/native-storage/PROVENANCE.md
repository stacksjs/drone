# Explicit published Stacks source bridge

The completed-artifact-directory.ts and prepared-completed-artifact-directory.ts modules are byte-for-byte copies from
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

The complete temporary-workspaces.ts module is a byte-for-byte copy from published
Stacks main 516c587bd1c553088ea5dff7f42985b9b49d0f0b. SHA-256:
9a0fd4bde4f6bf9e82658193241699d629fb27511e1c7e6092415bb34007e096.
Managed datasets call only inspectDirectoryMounts, which checks canonical directory
mount exclusion without global process-reference inspection. Unknown mount visibility
blocks. The copied retirement journal is not called and no deletion is introduced.
