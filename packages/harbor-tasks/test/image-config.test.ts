import { describe, expect, it } from "vitest";
import { fetchImageRuntimeConfig, parseImageReference } from "../src/image-config";

describe("parseImageReference", () => {
  it.each([
    ["alexgshaw/fix-git:20251031", { registry: "registry-1.docker.io", repository: "alexgshaw/fix-git", reference: "20251031" }],
    ["python", { registry: "registry-1.docker.io", repository: "library/python", reference: "latest" }],
    ["docker.io/library/node:22", { registry: "registry-1.docker.io", repository: "library/node", reference: "22" }],
    ["ghcr.io/org/img@sha256:abc", { registry: "ghcr.io", repository: "org/img", reference: "sha256:abc" }],
    ["localhost:5000/team/img", { registry: "localhost:5000", repository: "team/img", reference: "latest" }],
  ])("parses %s", (image, expected) => {
    expect(parseImageReference(image)).toEqual(expected);
  });
});

describe("fetchImageRuntimeConfig", () => {
  it("authenticates with the bearer challenge and picks the platform manifest", async () => {
    const calls: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const auth = new Headers(init?.headers).get("authorization");
      if (url.startsWith("https://auth.example/token")) return json({ token: "t0k" });
      if (auth !== "Bearer t0k") {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.example/token",service="registry.example"' } });
      }
      if (url.endsWith("/manifests/1.0")) {
        return json({ manifests: [
          { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
          { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
        ] });
      }
      if (url.endsWith("/manifests/sha256:amd")) return json({ config: { digest: "sha256:cfg" } });
      if (url.endsWith("/blobs/sha256:cfg")) {
        return json({ config: { WorkingDir: "/app/personal-site", User: "", Env: ["PATH=/usr/bin", "LANG=C.UTF-8"] } });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const config = await fetchImageRuntimeConfig("registry.example/team/task:1.0", { fetch: fetchImpl });
    expect(config).toEqual({ workingDir: "/app/personal-site", user: null, env: { PATH: "/usr/bin", LANG: "C.UTF-8" } });
    const tokenUrl = new URL(calls.find((url) => url.startsWith("https://auth.example/token"))!);
    expect(tokenUrl.searchParams.get("scope")).toBe("repository:team/task:pull");
    expect(tokenUrl.searchParams.get("service")).toBe("registry.example");
  });

  it("calls fetch unbound, as Workers' global fetch requires", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    // Workers' fetch throws "Illegal invocation" when called as a method.
    const fetchImpl = (function (this: unknown, input: string | URL | Request) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      const url = String(input);
      if (url.endsWith("/manifests/1.0")) return Promise.resolve(json({ config: { digest: "sha256:cfg" } }));
      if (url.endsWith("/blobs/sha256:cfg")) return Promise.resolve(json({ config: { WorkingDir: "/app" } }));
      return Promise.resolve(new Response("", { status: 404 }));
    }) as typeof fetch;

    const config = await fetchImageRuntimeConfig("registry.example/team/task:1.0", { fetch: fetchImpl });
    expect(config.workingDir).toBe("/app");
  });
});
