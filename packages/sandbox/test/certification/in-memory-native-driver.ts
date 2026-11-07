import {
  declarePersistenceCapabilities,
  type SandboxPort,
  type SessionSandboxDriver,
} from "../../src/index";

export interface PreparedMarker {
  path: string;
  content: string;
}

class InMemorySandbox implements SandboxPort {
  readonly files = new Map<string, string>();
  destroyed = false;

  async exec(command: string): Promise<string> {
    this.assertLive();
    const echo = /^echo (.*)$/.exec(command);
    return echo ? echo[1]! : `${command}: not found\n[exit exit=127]`;
  }

  async readFile(path: string): Promise<string> {
    this.assertLive();
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<string> {
    this.assertLive();
    this.files.set(path, content);
    return `wrote ${path}`;
  }

  private assertLive(): void {
    if (this.destroyed) throw new Error("sandbox destroyed");
  }
}

/**
 * A native SessionSandboxDriver with no v0 SandboxFactory behind it. It
 * stands in for the first native driver (Cloudflare, ADR 0014 rollout step 1,
 * follow-up PR) so the certification suite is proven against more than the
 * compatibility wrapper.
 */
export function createInMemoryNativeDriver(marker: PreparedMarker): SessionSandboxDriver {
  return {
    provider: "in-memory-native",
    capabilities: declarePersistenceCapabilities({
      workspace: { strategy: "retained_runtime", durability: "best_effort" },
      outputs: { strategy: "final_collect", durability: "best_effort" },
    }),
    async acquire({ signal }) {
      if (signal.aborted) throw signal.reason;
      return new InMemorySandbox();
    },
    async prepare({ sandbox }) {
      await sandbox.writeFile(marker.path, marker.content);
    },
    async release({ sandbox }) {
      (sandbox as InMemorySandbox).destroyed = true;
    },
  };
}
