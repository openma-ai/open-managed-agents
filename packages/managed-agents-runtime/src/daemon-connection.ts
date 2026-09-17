/** Transport boundary shared by the standalone and desktop daemon hosts. */
export interface DaemonSocket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): this;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export type DaemonConnectionState = "connecting" | "online" | "offline" | "occupied" | "expired" | "stopped";
export interface DaemonChannel {
  /** False if this connection has been replaced, closed, or stopped. */
  send(message: Record<string, unknown>): boolean;
}
export interface DaemonConnectionOptions {
  openSocket(): DaemonSocket;
  onOpen(channel: DaemonChannel): Promise<void>;
  onMessage(message: Record<string, unknown>): void;
  onState?(state: DaemonConnectionState): void;
}

export class DaemonConnection {
  readonly #options: DaemonConnectionOptions;
  #socket: DaemonSocket | null = null;
  #stopped = true;
  #backoffMs = 1_000;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #reconnect: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DaemonConnectionOptions) { this.#options = options; }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#backoffMs = 1_000;
    this.#attach();
  }

  stop(): void { this.#finish("stopped"); }

  send(message: Record<string, unknown>): boolean {
    return this.#socket ? this.#send(this.#socket, message) : false;
  }

  #attach(): void {
    if (this.#stopped) return;
    this.#options.onState?.("connecting");
    // The embedding host may cancel in response to the state notification.
    if (this.#stopped) return;
    let socket: DaemonSocket;
    try { socket = this.#options.openSocket(); }
    catch { this.#retry(); return; }
    this.#socket = socket;
    let lastPongAt = Date.now();
    const current = () => !this.#stopped && this.#socket === socket;
    // Also bounds a TCP/TLS/WebSocket handshake that never opens.
    this.#heartbeat = setInterval(() => {
      if (!current()) return;
      if (Date.now() - lastPongAt >= 75_000) { this.#drop(socket); return; }
      if (socket.readyState === 1) this.#send(socket, { type: "ping" });
    }, 25_000);
    socket.on("open", () => {
      if (!current()) return;
      lastPongAt = Date.now();
      // A channel is pinned to this socket. Delayed agent discovery must never
      // publish its greeting onto a subsequent connection.
      try {
        void this.#options.onOpen({ send: (message) => this.#send(socket, message) })
          .catch(() => this.#drop(socket));
      } catch { this.#drop(socket); }
    });
    socket.on("message", (data: { toString(): string } | string) => {
      if (!current()) return;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(typeof data === "string" ? data : data.toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        message = parsed as Record<string, unknown>;
      } catch { return; }
      if (message.type === "pong") { lastPongAt = Math.max(lastPongAt, Date.now()); return; }
      if (message.type === "welcome") {
        this.#backoffMs = 1_000;
        this.#options.onState?.("online");
        if (!current()) return;
      }
      this.#options.onMessage(message);
    });
    socket.on("unexpected-response", (_request: unknown, response: { statusCode?: number; resume?(): void }) => {
      response.resume?.();
      if (!current()) return;
      if (response.statusCode === 409) this.#finish("occupied");
      else if ([401, 403, 404].includes(response.statusCode ?? 0)) this.#finish("expired");
      else this.#drop(socket);
    });
    socket.on("error", () => this.#drop(socket));
    socket.on("close", () => this.#drop(socket));
  }

  #send(socket: DaemonSocket, message: Record<string, unknown>): boolean {
    if (this.#stopped || this.#socket !== socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(message)); return true; }
    catch { this.#drop(socket); return false; }
  }

  #closeSocket(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    const socket = this.#socket;
    this.#socket = null;
    // Clear ownership before closing; close/error may fire synchronously.
    if (!socket || socket.readyState === 3) return;
    try {
      if (socket.terminate) socket.terminate();
      else socket.close(1000, "daemon connection closed");
    } catch { /* Already closed. Its callbacks are fenced by socket identity. */ }
  }

  #drop(socket: DaemonSocket): void {
    if (this.#stopped || this.#socket !== socket) return;
    this.#closeSocket();
    this.#retry();
  }

  #retry(): void {
    if (this.#stopped || this.#reconnect !== null) return;
    this.#options.onState?.("offline");
    if (this.#stopped) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(delay * 2, 60_000);
    this.#reconnect = setTimeout(() => {
      this.#reconnect = null;
      this.#attach();
    }, delay);
  }

  #finish(state: "occupied" | "expired" | "stopped"): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#reconnect !== null) clearTimeout(this.#reconnect);
    this.#reconnect = null;
    this.#closeSocket();
    this.#options.onState?.(state);
  }
}
