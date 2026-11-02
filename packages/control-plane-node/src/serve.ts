// Host a control plane in this process: listen, and optionally turn SIGTERM /
// SIGINT into an orderly stop. Used by the main-node executable and by
// deployment presets (Fly) that assemble their own NodeConfig; embedders that
// already own an HTTP server mount controlPlane.fetch instead.

import { serve, type ServerType } from "@hono/node-server";

import type { NodeControlPlane } from "./control-plane.js";

export interface ServeNodeControlPlaneOptions {
  host: string;
  /** 0 asks the OS for an ephemeral port; read it back from `address.port`. */
  port: number;
  /**
   * Install SIGTERM/SIGINT handlers that stop the control plane and then call
   * `exit(0)`. Omit when the host process owns signal handling. `exit`
   * defaults to process.exit and is injectable for tests.
   */
  signals?: { exit?: (code: number) => void };
}

export interface NodeServer {
  readonly address: { host: string; port: number };
  /** Stop accepting connections and remove any installed signal handlers. Does not stop the control plane. */
  close(): Promise<void>;
}

export async function serveNodeControlPlane(
  controlPlane: NodeControlPlane,
  options: ServeNodeControlPlaneOptions,
): Promise<NodeServer> {
  let onListening!: (address: { host: string; port: number }) => void;
  const listening = new Promise<{ host: string; port: number }>((resolve) => { onListening = resolve; });
  const server: ServerType = serve(
    { fetch: controlPlane.fetch, port: options.port, hostname: options.host },
    (info) => onListening({ host: info.address, port: info.port }),
  );
  const address = await Promise.race([
    listening,
    new Promise<never>((_, reject) => server.once("error", reject)),
  ]);

  const { logger } = controlPlane;
  logger.info(
    { op: "main-node.listening", address: address.host, port: address.port, db: controlPlane.backendDescription },
    `listening on http://${address.host}:${address.port}`,
  );

  const installed: Array<[NodeJS.Signals, () => void]> = [];
  if (options.signals) {
    const exit = options.signals.exit ?? ((code: number) => process.exit(code));
    let stopping = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => {
        if (stopping) return;
        stopping = true;
        void controlPlane.stop(signal).then(() => exit(0));
      };
      process.on(signal, handler);
      installed.push([signal, handler]);
    }
  }

  return {
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const [signal, handler] of installed) process.off(signal, handler);
        installed.length = 0;
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
