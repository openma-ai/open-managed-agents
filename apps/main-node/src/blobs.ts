// Blob components: where memory documents and workspace files live.

import { mkdirSync } from "node:fs";

import { LocalFsBlobStore as MemoryLocalFsBlobStore } from "@open-managed-agents/memory-store/adapters/local-fs-blob";
import type { BlobStore as MemoryBlobStore } from "@open-managed-agents/memory-store";
import { S3BlobStore as FilesS3BlobStore, type BlobStore } from "@open-managed-agents/blob-store";
import { LocalFsBlobStore as FilesLocalFsBlobStore } from "@open-managed-agents/blob-store/adapters/local-fs";

import type { NodeConfig } from "./config.js";

export interface S3Location {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface MemoryBlobs {
  store: MemoryBlobStore;
  description: string;
  /**
   * Set when the store is a local directory: enables the filesystem watcher
   * and gives sandboxes a memoryRoot. Absent for remote or custom stores.
   */
  localDir?: string;
  /** Set when the store is S3: enables the cross-replica S3 poller. */
  s3?: S3Location & { pollIntervalMs: number };
}

export interface FilesBlobs {
  store: BlobStore;
  description: string;
}

export interface NodeBlobs {
  memory: MemoryBlobs;
  files: FilesBlobs;
}

export async function createMemoryBlobs(config: NodeConfig["blobs"]["memory"]): Promise<MemoryBlobs> {
  if (config.kind === "s3") {
    const { S3BlobStore } = await import("@open-managed-agents/memory-store/adapters/s3-blob");
    const s3 = {
      endpoint: config.endpoint,
      bucket: config.bucket,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
      pollIntervalMs: config.pollIntervalMs ?? 30_000,
    };
    return {
      store: new S3BlobStore({
        endpoint: s3.endpoint,
        bucket: s3.bucket,
        accessKeyId: s3.accessKey,
        secretAccessKey: s3.secretKey,
        region: s3.region,
      }),
      description: `s3 ${s3.endpoint}/${s3.bucket}`,
      s3,
    };
  }
  return {
    store: new MemoryLocalFsBlobStore({ baseDir: config.dir }),
    description: `localfs ${config.dir}`,
    localDir: config.dir,
  };
}

export function createFilesBlobs(config: NodeConfig["blobs"]["files"]): FilesBlobs {
  if (config.kind === "s3") {
    return {
      store: new FilesS3BlobStore({
        endpoint: config.endpoint,
        bucket: config.bucket,
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
        region: config.region,
      }),
      description: `s3 ${config.endpoint}/${config.bucket}`,
    };
  }
  mkdirSync(config.dir, { recursive: true });
  return {
    store: new FilesLocalFsBlobStore({ baseDir: config.dir }),
    description: `localfs ${config.dir}`,
  };
}
