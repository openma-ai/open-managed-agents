// Blob component contract: where memory documents and workspace files live.
// The control plane only sees stores and the facts it needs to wire watchers;
// a distribution chooses the backends (the OMA default builds local-directory
// or S3 stores from NodeConfig in @open-managed-agents/main-node/components).

import type { BlobStore as MemoryBlobStore, MemoryRepo } from "@open-managed-agents/memory-store";
import type { BlobStore } from "@open-managed-agents/blob-store";
import type { NodeDialect } from "@open-managed-agents/node-database";
import type { SqlClient } from "@open-managed-agents/sql-client";

export interface S3Location {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  prefix?: string;
  forcePathStyle?: boolean;
  requestChecksumCalculation?: "WHEN_REQUIRED" | "WHEN_SUPPORTED";
  conditionalCreate?: "if-none-match" | "oss-forbid-overwrite";
}

/** What the control plane hands a memory-blob change poller when it starts it. */
export interface MemoryBlobPollerContext {
  sql: SqlClient;
  sqlDialect: NodeDialect;
  memoryRepo: MemoryRepo;
  /** Per-process token used as the poller's lease owner. */
  replicaId: string;
}

export interface MemoryBlobs {
  store: MemoryBlobStore;
  description: string;
  /**
   * Set when the store is a local directory: enables the filesystem watcher
   * and gives sandboxes a memoryRoot. Absent for remote or custom stores.
   */
  localDir?: string;
  /** Set when the store is S3: the bucket the cross-replica poller watches. */
  s3?: S3Location & { pollIntervalMs: number };
  /**
   * Start the cross-replica change poller for a remote store. The control
   * plane calls it once, only in processes that own long-lived work, and
   * stops the result on shutdown. The default S3 memory blobs supply it.
   */
  startPoller?(context: MemoryBlobPollerContext): Promise<{ stop: () => Promise<void> }>;
}

export interface FilesBlobs {
  store: BlobStore;
  description: string;
}

export interface NodeBlobs {
  memory: MemoryBlobs;
  files: FilesBlobs;
}
