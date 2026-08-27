interface CfManagedRuntimeEnvironment {
  SESSION_DO?: DurableObjectNamespace;
  SANDBOX_sandbox_default?: Fetcher;
}

/** Routes the final managed-runtime HTTP codec to the CF sandbox lane. */
export class CfManagedRuntimeFetcher {
  constructor(private readonly environment: CfManagedRuntimeEnvironment) {}

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const service = this.environment.SANDBOX_sandbox_default;
    if (service !== undefined) return service.fetch(input, init);

    const namespace = this.environment.SESSION_DO;
    if (namespace === undefined) {
      return Promise.resolve(
        new Response("Managed runtime binding unavailable", { status: 503 }),
      );
    }
    const request = input instanceof Request ? input : new Request(input, init);
    const workspaceId = request.headers.get("x-oma-workspace-id")?.trim();
    if (workspaceId === undefined || workspaceId.length === 0) {
      return Promise.resolve(
        new Response("Managed runtime workspace scope is required", {
          status: 400,
        }),
      );
    }
    const url = new URL(request.url);
    const match = /^\/sessions\/([^/]+)\/(.*)$/u.exec(url.pathname);
    if (match === null) {
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }
    const [, encodedSessionId, rest] = match;
    if (encodedSessionId === undefined || rest === undefined) {
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(encodedSessionId);
    } catch {
      return Promise.resolve(new Response("Invalid session ID", { status: 400 }));
    }
    const stub = namespace.get(
      namespace.idFromName(JSON.stringify([workspaceId, sessionId])),
    );
    return stub.fetch(
      new Request(`http://managed-session/${rest}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
      }),
    );
  }
}
