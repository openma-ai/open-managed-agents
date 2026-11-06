// Host a control plane in this process: listen, and optionally turn SIGTERM /
// SIGINT into an orderly stop. Used by the main-node executable and by
// deployment presets (Fly) that assemble their own NodeConfig; embedders that
// already own an HTTP server mount controlPlane.fetch instead.

import { serve, type ServerType } from "@hono/node-server";
import type { Socket } from "node:net";

import type { NodeControlPlane } from "./control-plane.js";

export interface ServeNodeControlPlaneOptions {
  host: string;
  /** 0 asks the OS for an ephemeral port; read it back from `address.port`. */
  port: number;
  /**
   * Install SIGTERM/SIGINT handlers: stop HTTP admission, drain the control
   * plane, then exit. Failures/deadline expiry exit with code 1. Omit when the
   * host process owns signals. The default overall deadline is 30 seconds.
   */
  signals?: { exit?: (code: number) => void; timeoutMs?: number };
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
  const shutdownTimeoutMs = options.signals?.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 0 || shutdownTimeoutMs > 2_147_483_647) {
    throw new Error("HTTP shutdown timeout must be a bounded non-negative integer");
  }
  let accepting = true;
  let onListening!: (address: { host: string; port: number }) => void;
  const listening = new Promise<{ host: string; port: number }>((resolve) => { onListening = resolve; });
  const server: ServerType = serve(
    { fetch: (request) => accepting ? controlPlane.fetch(request)
        : new Response("Server is shutting down", { status: 503, headers: { connection: "close" } }),
      port: options.port, hostname: options.host },
    (info) => onListening({ host: info.address, port: info.port }),
  );
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
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
  const removeSignals = () => {
    for (const [signal, handler] of installed) process.off(signal, handler);
    installed.length = 0;
  };
  let closing: Promise<void> | null = null;
  const beginClose = (): Promise<void> => {
    accepting = false;
    // server.close() stops new connections synchronously; its callback waits
    // for outstanding requests. Start the worker drain only after this call.
    closing ??= new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    return closing;
  };
  if (options.signals) {
    const exit = options.signals.exit ?? ((code: number) => process.exit(code));
    let stopping = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => {
        if (stopping) return;
        stopping = true;
        const closed = beginClose();
        let finished = false;
        const finish = (code: number, error?: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          removeSignals();
          if (code !== 0) {
            try {
              logger.error({ err: error, op: "main-node.shutdown.failed" }, "control plane shutdown failed");
            } catch {
              // A failed logger cannot bypass the final process exit.
            }
            for (const socket of sockets) socket.destroy();
          }
          exit(code);
        };
        const deadline = setTimeout(() => finish(1, new Error("Control plane shutdown deadline exceeded")), shutdownTimeoutMs);
        void Promise.all([closed, Promise.resolve().then(() => controlPlane.stop(signal))])
          .then(() => finish(0), (error: unknown) => finish(1, error));
      };
      process.on(signal, handler);
      installed.push([signal, handler]);
    }
  }

  return {
    address,
    close: () => {
      removeSignals();
      return beginClose();
    },
  };
}
