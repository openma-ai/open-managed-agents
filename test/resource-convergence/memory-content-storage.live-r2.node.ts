// Opt-in storage-only runtime regression: no agent/model inference.
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { bootOpenAINode } from "../../apps/main-node/test/_helpers/openai-node-process";

it("hydrates current and history from task R2 across Node process restart", async () => {
  const credentialFile = process.env.RESOURCE_R2_TASK_CREDENTIAL_FILE;
  if (!credentialFile) throw new Error("Explicit task credential file required");
  const credentials = JSON.parse(readFileSync(credentialFile, "utf8"));
  const prefix = `memory-content-validation/${randomUUID()}/`;
  const storageEnvironment: Record<string, string> = {};
  for (const family of ["FILES", "MEMORY"]) {
    for (const key of ["ENDPOINT", "BUCKET", "REGION", "ACCESS_KEY", "SECRET_KEY"]) {
      const name = `${family}_S3_${key}`;
      if (typeof credentials[name] !== "string") throw new Error(`Missing task storage field ${name}`);
      storageEnvironment[name] = credentials[name];
    }
    storageEnvironment[`${family}_S3_PREFIX`] = prefix;
    storageEnvironment[`${family}_S3_FORCE_PATH_STYLE`] = "1";
    storageEnvironment[`${family}_S3_REQUEST_CHECKSUM_CALCULATION`] = "WHEN_REQUIRED";
  }
  const { S3Client, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } = createRequire(new URL("../../packages/blob-store/package.json", import.meta.url))("@aws-sdk/client-s3");
  const objects = new S3Client({ endpoint: credentials.MEMORY_S3_ENDPOINT, region: credentials.MEMORY_S3_REGION, forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED", credentials: { accessKeyId: credentials.MEMORY_S3_ACCESS_KEY, secretAccessKey: credentials.MEMORY_S3_SECRET_KEY } });
  const fixture = await bootOpenAINode(() => { throw new Error("Model inference forbidden in storage test"); }, { storageEnvironment });
  const request = (path: string, body?: unknown) => fetch(fixture.baseURL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "anthropic-beta": "managed-agents-2026-04-01", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async (path: string, body?: unknown) => {
    const response = await request(path, body);
    expect(response.ok, `API ${path} status ${response.status}`).toBe(true);
    return response.json() as Promise<any>;
  };
  try {
    const bytes = `object-only Memory\n精确 bytes ${randomUUID()}\n`;
    const store = await json("/v1/memory_stores", { name: "object-validation" });
    const memory = await json(`/v1/memory_stores/${store.id}/memories`, { path: "/fact.md", content: bytes });
    const currentPath = `/v1/memory_stores/${store.id}/memories/${memory.id}?view=full`;
    const historyPath = `/v1/memory_stores/${store.id}/memory_versions/${memory.memory_version_id}?view=full`;
    const Database = createRequire(new URL("../../apps/main-node/package.json", import.meta.url))("better-sqlite3");
    const db = new Database(`${fixture.directory}/oma.db`, { readonly: true });
    let contentKey: string;
    try {
      const documents = ["managed_memories", "managed_memory_versions"].map(table => {
        const rows = db.prepare(`SELECT document FROM ${table}`).all();
        expect(rows).toHaveLength(1);
        const document = JSON.parse(rows[0].document);
        expect(document).not.toHaveProperty("content");
        expect(typeof document.contentObjectKey).toBe("string");
        return document;
      });
      expect(documents[0].contentObjectKey).toBe(documents[1].contentObjectKey);
      contentKey = documents[0].contentObjectKey;
    } finally { db.close(); }
    const target = { Bucket: credentials.MEMORY_S3_BUCKET, Key: prefix + contentKey! };
    const readObject = async () => (await objects.send(new GetObjectCommand(target))).Body.transformToString();
    expect(await readObject()).toBe(bytes);
    for (const path of [currentPath, historyPath]) expect((await json(path)).content).toBe(bytes);
    await fixture.restart();
    expect(await readObject()).toBe(bytes);
    for (const path of [currentPath, historyPath]) expect((await json(path)).content).toBe(bytes);
    console.log({ op: "object_read_restart", sqlBodyFields: 0, sha256: createHash("sha256").update(bytes).digest("hex") });
    // Fault injection affects only this test's uniquely prefixed object.
    await objects.send(new DeleteObjectCommand(target));
    try {
      for (const path of [currentPath, historyPath]) {
        const response = await request(path);
        console.log({ op: "missing_object", status: response.status });
        expect(response.status).toBe(500);
      }
    } finally { await objects.send(new PutObjectCommand({ ...target, Body: bytes })); }
    expect(await readObject()).toBe(bytes);
    for (const path of [currentPath, historyPath]) expect((await json(path)).content).toBe(bytes);
    expect(fixture.requests).toHaveLength(0);
    console.log({ op: "exact_object_restore", modelRequests: 0 });
  } finally { await fixture.dispose(); objects.destroy(); }
});
