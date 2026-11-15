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

The official E2B `managedTemplate` prepares `/mnt/memory` at image build time
with owner `oma-worker:oma-worker` and mode `0755`. Its root management launcher
is deliberately separate: the managed E2B executor runs tools and host-owned
Memory materialization as `oma-worker`, even when the SDK default user is root.
Checking writability as root therefore does not validate this precondition.
Existing templates must be rebuilt and independently verified; do not repair a
running Session with privileged `chmod`, switch its tool user to root, or move
Memory to temporary storage. Custom images using another configured tool user
must provide the same writable-root contract for that user. Worker-owned native
Memory mounts remain the responsibility of the storage attachment path; the
empty image directory is not a mount or evidence of durable publication.

Explicit [guest sudo](managed-guest-privileges.md) can override guest filesystem
permissions. The ownership/readonly checks below describe default execution,
not a security boundary against guest root. Host-side readonly publication and
fencing rules remain in force.

## Managed E2B allocation and storage modes

The shared E2B adapter prepares `/workspace`, `/mnt/session`,
`/mnt/session/outputs`, and `/mnt/memory` on **new allocations and filesystem
restores**. It obtains the ordinary executor's UID and primary GID, rejects
symlink roots, and assigns only those directory entries (non-recursively).
Node and Cloudflare use this same managed preparation. It does not change
ownership when attaching/resuming a live handle, recursively rewrite attachments,
or grant access to root-only launcher or rclone control directories. Read-only
attachments retain their own permissions. Native FUSE mounts must also select
this execution UID/GID; a writable empty directory is not a durable mount.

Storage selection is composition-specific:

| Composition | Memory bytes / synchronization | Outputs and workspace |
| --- | --- | --- |
| Default Node managed Session | `SqlMemoryDocumentStore` is canonical; `file_sync` materializes and fenced-CAS synchronizes attached stores. `MEMORY_S3_*` alone does not switch this to native FUSE. | Remote E2B requires durable Outputs. Configured `FILES_S3_ENDPOINT`, `FILES_S3_BUCKET`, `FILES_S3_ACCESS_KEY`, `FILES_S3_SECRET_KEY` select shared object-backed Outputs. Workspace defaults to ephemeral; `checkpoint_restore` requires durable Files storage. |
| Node factory declaring `nativeMemoryStoreMount` | Native generation-scoped Memory workspaces are materialized from canonical Memory and reconciled back; S3 snapshot namespaces are not the legacy `storeId/path` namespace. Node Work rclone uses `MEMORY_S3_*`. | Native Work Outputs (when shared Outputs are absent) use `session-outputs/<workspace>/<session>` in that configured bucket. Fenced drain must acknowledge upload before publication. |
| Cloudflare E2B with no parent S3 key | Required `MEMORY_BUCKET` and `FILES_BUCKET` Worker bindings provide copy-sync persistence. | Output publication uses the Files binding; it needs no S3 key. |
| Cloudflare E2B native | Complete `CLOUDFLARE_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `MEMORY_BUCKET_NAME`, `FILES_BUCKET_NAME`; optional complete `R2_FILES_*` pair for separate Files credentials. Prefix-scoped temporary credentials back verified rclone mounts. | Native mounts, not local fallback; partial configuration, mount failure and failed upload acknowledgement are errors. |

`memory_blobs: s3` in health reports describes a configured blob service, not
which managed Memory composition is selected. A managed Memory API/SQL read
therefore does not certify R2, and a miss at a legacy S3 key does not by itself
prove data loss. Validate the selected mode and its exact namespace separately.
The legacy standalone executor's s3fs methods are not the managed Node Work
native adapter and do not establish that adapter's persistence guarantees.

rclone's root-only Unix RC server is launched once in the background, with a
bounded readiness check and private log. `rclone --daemon --rc` is not used:
the official 1.74.1 distribution starts RC in both parent and child and collides
on the same Unix socket. A process exit or missing mount fails attachment;
mount readiness alone still does not acknowledge pending upload completion.

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

For the official E2B image, the explicit provider bootstrap gate is
`apps/main-node/node_modules/.bin/tsx packages/sandbox-adapter-e2b/test/template-memory-bootstrap.mts`
from the repository root. Supply `E2B_API_KEY` through the approved secured
process environment, `OMA_E2B_TEMPLATE` naming the old task template being
checked, and `OMA_E2B_MEMORY_RECEIPT` for the result file. This opt-in gate
creates one new isolated sandbox, proves the old image rejects worker writes,
executes the exact official image bootstrap command in that test allocation,
and checks worker materialization/read-only isolation before pausing it.
It never modifies an existing Session or publishes a template. A passing
bootstrap-command gate does **not** certify a rebuilt image or remote Memory
upload: those require a separately reviewed template build and provider run.
