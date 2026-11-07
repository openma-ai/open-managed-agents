import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sandboxFactory as localSubprocessFactory } from "../src/adapters/local-subprocess";
import { wrapLegacySandboxFactory } from "../src/index";
import { createInMemoryNativeDriver } from "./certification/in-memory-native-driver";
import { describeSessionSandboxCertification } from "./certification/session-sandbox.certification";

const MARKER = { path: "/workspace/.openma-prepared", content: "PREPARED_OK" };

describeSessionSandboxCertification("v0 wrapper over LocalSubprocessSandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "openma-session-sandbox-cert-"));
  return {
    driver: wrapLegacySandboxFactory(localSubprocessFactory, {
      provider: "local-subprocess",
      env: {},
      prepare: async ({ sandbox }) => {
        await sandbox.writeFile(MARKER.path, MARKER.content);
      },
    }),
    context: { sessionId: "sess_certification", workdir: join(root, "workdir") },
    preparedMarker: MARKER,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

describeSessionSandboxCertification("native reference driver", async () => ({
  driver: createInMemoryNativeDriver(MARKER),
  context: { sessionId: "sess_certification", workdir: "/unused" },
  preparedMarker: MARKER,
}));
