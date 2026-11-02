// The default blob components: a local directory or S3 for memory documents
// and workspace files, chosen from NodeConfig.

import { mkdirSync } from "node:fs";

import { LocalFsBlobStore as MemoryLocalFsBlobStore } from "@open-managed-agents/memory-store/adapters/local-fs-blob";
import { S3BlobStore as FilesS3BlobStore } from "@open-managed-agents/blob-store";
import { LocalFsBlobStore as FilesLocalFsBlobStore } from "@open-managed-agents/blob-store/adapters/local-fs";

import type { FilesBlobs, MemoryBlobs } from "@open-managed-agents/control-plane-node";

import type { NodeConfig } from "./config.js";

export type { FilesBlobs, MemoryBlobs, NodeBlobs, S3Location } from "@open-managed-agents/control-plane-node";

export async function createMemoryBlobs(config: NodeConfig["blobs"]["memory"]): Promise<MemoryBlobs> {
  if (config.kind === "s3") {
    const { S3BlobStore } = await import("@open-managed-agents/memory-store/adapters/s3-blob");
    const s3 = {
      endpoint: config.endpoint,
      bucket: config.bucket,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
      ...(config.prefix ? { prefix: config.prefix } : {}),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      ...(config.requestChecksumCalculation ? { requestChecksumCalculation: config.requestChecksumCalculation } : {}),
      ...(config.conditionalCreate ? { conditionalCreate: config.conditionalCreate } : {}),
      pollIntervalMs: config.pollIntervalMs ?? 30_000,
    };
    return {
      store: new S3BlobStore({
        endpoint: s3.endpoint,
        bucket: s3.bucket,
        accessKeyId: s3.accessKey,
        secretAccessKey: s3.secretKey,
        region: s3.region,
        ...(s3.prefix ? { prefix: s3.prefix } : {}),
        ...(s3.forcePathStyle === undefined ? {} : { forcePathStyle: s3.forcePathStyle }),
        ...(s3.requestChecksumCalculation ? { requestChecksumCalculation: s3.requestChecksumCalculation } : {}),
        ...(s3.conditionalCreate ? { conditionalCreate: s3.conditionalCreate } : {}),
      }),
      description: `s3 ${s3.endpoint}/${s3.bucket}`,
      s3,
      startPoller: async (context) => {
        const { startS3MemoryPoller } = await import("./lib/s3-memory-poller.js");
        return startS3MemoryPoller({ ...context, intervalMs: s3.pollIntervalMs, s3 });
      },
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
        ...(config.prefix ? { prefix: config.prefix } : {}),
        ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
        ...(config.requestChecksumCalculation ? { requestChecksumCalculation: config.requestChecksumCalculation } : {}),
        ...(config.conditionalCreate ? { conditionalCreate: config.conditionalCreate } : {}),
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
