# Memory Stores in a sandbox

A **Memory Store** is a set of text files (notes, preferences, facts) that
outlives any one Session. A Session that attaches a store sees it as a
directory inside its sandbox:

```
/mnt/memory/<name>/
```

`<name>` is the store's name on the Session resource (or its id when it has
no name). The agent reads and writes ordinary files there with its normal
tools. The sandbox also gets `OMA_MEMORY_DIR=/mnt/memory` and one
`OMA_MEMORY_<NAME>=/mnt/memory/<name>` variable per store.

This page covers the Node control plane (`apps/main-node`), the provider
runtime, and the Docker runtime. Hosted Cloudflare has its own R2 + FUSE
path, listed in the adapter table below.

## Sharing: the store is the source of truth

One Memory Store is usually attached to many Sessions, and so to many
sandboxes, at the same time. The store, kept by the control plane, is the
only source of truth. A directory under `/mnt/memory` is just that sandbox's
working copy.

File sync is **deliberately weak synchronization**. It is not a shared
filesystem, and it makes no attempt to be one:

- **A turn reads a snapshot.** The sandbox copy is the store as it was at
  the last sync point: when the sandbox was prepared, or the end of the
  previous turn. Writes that other Sessions make during this turn do not
  appear in this sandbox mid-turn.
- **Other Sessions' writes appear at the next turn.** Every turn barrier
  ends by rebasing the directory onto the store's current contents, so the
  next turn starts with everything that was saved in the meantime.
- **When two Sessions change the same file, the store's version wins.**
  The losing local edit is dropped. It is not merged and is not kept as a
  copy. In native mount mode the drop is logged as
  `main-node.managed_memory.conflicts`. File sync drops the edit the same
  way but does not write that log line today.

If you need edits from concurrent Sessions to be visible to each other
mid-turn, or never lost, a file-synced Memory Store is the wrong tool.

## Two modes

| | **File sync** (default) | **Native mount** (opt-in) |
|---|---|---|
| Works on | Any sandbox: needs only `exec`, `readFile`, `writeFile` | Sandboxes whose adapter implements `mountMemoryStore` |
| Selected by | Default for every sandbox factory | The composed factory declaring `capabilities.nativeMemoryStoreMount` |
| Before the turn | Copies each store into `/mnt/memory/<name>/` | Mounts a generation-scoped snapshot of the store's blobs at `/mnt/memory/<name>/` (s3fs, FUSE, or a host bind/symlink) |
| At the turn barrier | Writes local creates, edits and deletes back with a three-way compare-and-swap, then rebases the directory | Reconciles the mounted blob snapshot with the store the same way |
| Read-only stores | Copied without write permission (`chmod -R a-w`); never written back | Mounted read-only |
| Fence | Every write to the store first re-checks the Session execution fence | Same |

Only one mode is active per deployment. The control plane reads it once
from the composed sandbox factory. No environment variable or deploy flag
switches modes, and a mode that fails never falls back to the other.

### Opting into native mounts

Declare the capability on the factory you compose, and make sure the
adapter's mount really works in that deployment (for example, `MEMORY_S3_*`
is set for s3fs, or a shared `MEMORY_BLOB_DIR` exists for a bind mount):

```ts
import { withSandboxFactoryCapabilities } from "@open-managed-agents/sandbox";

const sandbox = withSandboxFactoryCapabilities(myFactory, {
  nativeMemoryStoreMount: true,
});
// nodeDefaults(config, { sandbox })
```

No built-in factory declares it.

## When sync happens (file sync)

1. **Sandbox preparation, before the first turn.** Each store is copied in.
   If a retained sandbox still holds edits from an earlier execution, those
   are written back first (fenced), and the copy is then refreshed.
2. **Turn barrier, after every turn.** Local changes are written back, and
   the directory is rebased onto the store's current contents.

A small bookkeeping manifest is kept under
`/workspace/.openma/session-inputs/` so that a restarted control plane can
tell what changed since the last sync.

## Conflict rule

The write-back compares three versions of each file: the **base** (what
the sandbox was given), the **local** file, and the **current** store
version.

| Situation | Result |
|---|---|
| Only the sandbox changed the file | The local version is written to the store |
| Only the store changed (another Session) | The store's version is pulled in |
| Both changed | **The store wins**; the local edit is dropped |
| Sandbox created a path that now exists in the store | The store wins |
| Sandbox deleted a file the store left unchanged | The file is deleted from the store |
| Sandbox deleted a file the store changed | The store's version comes back |

Creates and edits are applied before deletes, so a rename never loses the
only copy. A turn that would delete more than 50 files is refused as a
probable accident.

## Read-only stores

A `read_only` store is copied in without write permission. Writes inside
the sandbox fail with a permission error, and nothing is ever written back.
Every turn barrier re-copies the store, which also undoes any permission
change the agent made. Read-only stores need no execution fence.

## Image precondition: `/mnt/memory` must be writable

File sync creates `/mnt/memory/<name>` as the sandbox user. The sandbox
image must therefore let that user create `/mnt/memory` or write into an
existing one. If it cannot, the turn fails with
`SessionMemoryRootNotWritableError`, which names the directory. The fix
belongs in the image (for example, `mkdir -p /mnt/memory && chown <user>
/mnt/memory` at build time). The control plane does not use `sudo` and does
not move the store to a different path.

## Failure behavior

Every failure is an error that fails the turn. Nothing is silently skipped.

- **A sandbox command fails** (`mkdir`, `rm`, `chmod`, the file scan). The
  sync stops and reports the command's exit status and output. A status the
  adapter cannot report counts as a failure.
- **Writable store without an execution fence.** Refused before anything is
  copied.
- **Fence lost mid-sync.** Stops before the next write to the store
  (`Session Memory resource fence lost`).
- **Distrusted directory.** A writable store's directory, marker file, or
  manifest went missing (for example, the agent ran `rm -rf
  /mnt/memory/notes`). The directory is reset to the store and the turn fails
  with `SessionMemoryWorkspaceDistrustedError`. A wiped folder is never read
  as "delete everything".
- **Native mode on a sandbox without `mountMemoryStore`**, or a mount that
  fails. The turn fails; there is no fallback to file sync.

## Adapters

| Adapter | Mode on the Node control plane | What a native mount would need |
|---|---|---|
| `local-subprocess` | File sync | A `memoryRoot` on the host; `mountMemoryStore` symlinks it into the workdir |
| `docker` (managed runtime) | File sync | Not implemented |
| `e2b` | File sync | `MEMORY_S3_*` and a template with s3fs; `mountMemoryStore` mounts the bucket |
| `daytona` | File sync | `MEMORY_S3_*`; the adapter installs s3fs and mounts the bucket |
| `litebox` | File sync | A shared `memoryRoot`/`MEMORY_BLOB_DIR` bound into the VM before the first command |
| `boxrun` | File sync | Not possible: the HTTP API has no mount primitive |
| `sprites` | File sync | Not implemented |
| Cloudflare agent (`apps/agent`) | Native (R2 + FUSE), its own runtime path | R2 credentials for the FUSE mount |

"File sync" in this table is the default. Any adapter with a working
`mountMemoryStore` can be switched to native mode by a composer that
declares the capability.

## Adding a new adapter

1. **Implement `exec`, `readFile` and `writeFile`.** That is all file sync
   needs. `exec` must report a failing command's status in one of the shapes
   `parseExecResult` understands (`exit=N\n...`, `...\n[exit N]`,
   `[error: ...]`). Output with no status marker is read as success, so
   never drop a failure status.
2. **Map `/mnt/memory` and `/workspace`** to the same place for commands and
   for `readFile`/`writeFile`. If your adapter relocates these roots, as
   `local-subprocess` does, rewrite them in commands too.
3. **Make `/mnt/memory` writable** by the sandbox user in your default
   image.
4. **Optional: native mount.** Implement `mountMemoryStore` over the
   host's memory blobs and document what it needs. Do not declare
   `nativeMemoryStoreMount` on your built-in factory; leave the opt-in to
   composers who can guarantee the mount works in their deployment.
5. **Test against the real adapter.** See
   `packages/managed-runtime-sandbox/test/session-memory-local-sandbox.test.ts`
   for the pattern: write in one sandbox, synchronize, then read the result
   in a fresh one.
