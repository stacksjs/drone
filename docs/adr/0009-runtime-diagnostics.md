# ADR 9: Bounded runtime journals and offline diagnostic replay

Status: accepted for host-runtime development; physical acceptance remains pending.

Record typed owned-runtime command attempts before transport and replies after transport. Keep a
strict allowlist rather than serializing application context, configuration values, unknown wire
bytes or exceptions. Record immutable provenance digests, virtual/local epochs, counters and reset
flags. Raw images, location streams and credentials are outside this v1 runtime-only format.

Use an append-only SHA-256 chain, bounded asynchronous queue, bounded output and explicit drop
accounting. Reserve completion space, recover only a verified prefix after a partial final record,
and mark a missing footer as an unknown tail. Do not rotate or silently overwrite old evidence in
this first format. Hashes detect corruption; they do not authenticate the producer.

Native Stacks CLI commands and the standalone binary share recorder, verifier and replay code.
The stx viewer parses selected local files in the browser and never uploads private evidence.
Use explicit exclusive local file operations because the domain boundary requires queue bounds,
partial-write handling, fsync and no-overwrite semantics absent from ordinary storage put APIs.
No database CRUD entity or cloud upload job is introduced for immutable local bench evidence.

Replay is a pure diagnostic projection with no transport or authority capabilities. It reconstructs
recorded status and faults, not physics or complete mission state. Commissioning and signed update
checks stay blocked until their independent implementations and measured evidence exist. The owned
firmware and physical command surface are unchanged by this slice.
