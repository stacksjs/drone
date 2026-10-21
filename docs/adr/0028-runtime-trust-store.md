# Runtime trust store protocol

Status: implementation in progress for #42. This decision does not qualify deployment.

The update coordinator needs a private, independently bound state directory. An
immutable initial enrollment remains the anchor. A separately pinned store identity
binds its mutable protocol state to that enrollment. Missing or corrupt existing
state is an error, never a reason to initialize a replacement or lower a floor.

Use Bun's built-in SQLite for this protocol file. This is a deliberate exception
to model-derived application migrations: these records are a bounded local update
protocol, not application CRUD. The installed Stacks database factory uses global
configuration and its query facade resolves that configuration lazily. It does not
expose the isolated synchronous connection and commit ordering this protocol needs.
Native Stacks commands remain the entrypoints. No generic framework abstraction is
introduced for this single consumer, and no application database is reconfigured.

Two databases have separate responsibilities. A writer database holds an immediate
transaction across awaited work, excluding another coordinator. The protocol
database commits inputs and accepted metadata independently while that lease is
held. Both use a rollback journal, FULL synchronous commits, fullfsync where the
host supports it, zero busy timeout and verified configuration. The file format
has an application ID, version, exact schema and explicit size/count limits.
Existing databases are opened without creation. Symlinks, shared writable paths,
wrong ownership, extra hard links and unexpected schema are rejected.

Before an SDK fetch returns metadata, commit the exact bounded input or missing
response. Before its private cache write, commit each accepted metadata observation
and its high-water state. The cache is disposable; the anchor and protocol history
are not. Every attempt records its base generation and independently supplied fixed
wall time. New attempts cannot skip an unresolved attempt. Historical recovery
replays exact recorded inputs at that original time and can only retain floors.
Only a new verification at a trusted current time can authorize candidate use.
Unknown verification, crypto, persistence or resource failures remain maintenance
conditions. Operational error types alone do not prove invalid input.

Root-authorized timestamp or snapshot key rotation starts a new active metadata
epoch and invalidates both working-cache files, as required by TUF 5.3.11. Retain
the previous epochs and their floors. The global release-security floor never
decreases across an epoch change. Root rotation alone, without either authority
change, does not reset role floors.

The schema and recovery implementation must be exercised with signed repositories,
actual competing processes, SIGKILL cuts around input/prefix commits, corrupt and
missing files, clock reversal, and real host storage failures. SQLite commit or
process-crash evidence is not measured physical power-loss durability. Same-user
privileged disk rollback and malicious kernel/filesystem behavior require separate
hardware protection and are outside this host protocol's claims.

Protected preparation now uses this metadata operation to authenticate actual
image bytes before and after writing the existing signed-candidate format. The
same file writer serves standalone staging. Candidate inspection requires a root
pin from authenticated store readback when preparation uses the current rotated
root. A candidate receipt supplies no current trust or selection authority.

This v1 database journals metadata, not durable candidate ownership or slot
transitions. Installed, candidate and known-good slots and health confirmation
bound to an exact image and boot/session identity remain part of #42. No receipt or healthy boolean can select firmware. Physical installation,
bootloader behavior, secure boot and hardware anti-rollback remain gated by #2/#9.
