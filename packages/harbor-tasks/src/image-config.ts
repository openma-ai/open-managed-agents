/**
 * Reads an image's runtime config (WORKDIR, USER, ENV) straight from its OCI
 * registry. Harbor executes solution and verifier commands in the
 * container's default working directory; sandbox providers that pin their
 * own cwd (OpenSandbox uses /workspace) need this to reproduce Harbor's
 * behaviour without a local Docker daemon.
 */
export interface ImageRuntimeConfig {
  workingDir: string | null;
  user: string | null;
  env: Record<string, string>;
}

export interface ImageReference {
  registry: string;
  repository: string;
  reference: string;
}

const DOCKER_HUB = "registry-1.docker.io";
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export function parseImageReference(image: string): ImageReference {
  let rest = image.trim();
  let registry = DOCKER_HUB;
  const slash = rest.indexOf("/");
  if (slash > 0) {
    const head = rest.slice(0, slash);
    if (head.includes(".") || head.includes(":") || head === "localhost") {
      registry = head === "docker.io" ? DOCKER_HUB : head;
      rest = rest.slice(slash + 1);
    }
  }
  let reference = "latest";
  const at = rest.indexOf("@");
  if (at >= 0) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon > rest.lastIndexOf("/")) {
      reference = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }
  if (registry === DOCKER_HUB && !rest.includes("/")) rest = `library/${rest}`;
  if (!rest) throw new Error(`Invalid image reference: ${image}`);
  return { registry, repository: rest, reference };
}

type Fetch = typeof fetch;

function bearerChallenge(header: string | null): { realm: string; params: Record<string, string> } | null {
  if (!header || !/^bearer /i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) params[match[1]!] = match[2]!;
  const realm = params.realm;
  if (!realm) return null;
  delete params.realm;
  return { realm, params };
}

class RegistryClient {
  #token: string | undefined;
  constructor(private readonly ref: ImageReference, private readonly fetchImpl: Fetch) {}

  async get(path: string, accept?: string): Promise<Response> {
    const url = `https://${this.ref.registry}/v2/${this.ref.repository}/${path}`;
    const headers = (): Record<string, string> => ({
      ...(accept ? { accept } : {}),
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
    });
    let response = await this.fetchImpl(url, { headers: headers() });
    if (response.status === 401 && this.#token === undefined) {
      const challenge = bearerChallenge(response.headers.get("www-authenticate"));
      if (!challenge) throw new Error(`Registry ${this.ref.registry} requires unsupported authentication`);
      const tokenUrl = new URL(challenge.realm);
      for (const [key, value] of Object.entries(challenge.params)) tokenUrl.searchParams.set(key, value);
      if (!tokenUrl.searchParams.has("scope")) tokenUrl.searchParams.set("scope", `repository:${this.ref.repository}:pull`);
      const tokenResponse = await this.fetchImpl(tokenUrl.toString());
      if (!tokenResponse.ok) throw new Error(`Registry token request failed (HTTP ${tokenResponse.status})`);
      const body = await tokenResponse.json() as { token?: string; access_token?: string };
      this.#token = body.token ?? body.access_token;
      if (!this.#token) throw new Error("Registry token response had no token");
      response = await this.fetchImpl(url, { headers: headers() });
    }
    if (!response.ok) throw new Error(`Registry request ${path} failed (HTTP ${response.status})`);
    return response;
  }
}

interface Platform { os: string; architecture: string }

export async function fetchImageRuntimeConfig(
  image: string,
  options: { fetch?: Fetch; platform?: Platform } = {},
): Promise<ImageRuntimeConfig> {
  const ref = parseImageReference(image);
  const client = new RegistryClient(ref, options.fetch ?? fetch);
  const platform = options.platform ?? { os: "linux", architecture: "amd64" };
  let manifest = await (await client.get(`manifests/${ref.reference}`, MANIFEST_ACCEPT)).json() as {
    manifests?: Array<{ digest: string; platform?: Platform }>;
    config?: { digest: string };
  };
  if (manifest.manifests) {
    const entries = manifest.manifests;
    const chosen = entries.find((entry) => entry.platform?.os === platform.os && entry.platform.architecture === platform.architecture)
      ?? entries.find((entry) => entry.platform?.os === platform.os)
      ?? entries[0];
    if (!chosen) throw new Error(`Image index ${image} has no manifests`);
    manifest = await (await client.get(`manifests/${chosen.digest}`, MANIFEST_ACCEPT)).json() as typeof manifest;
  }
  if (!manifest.config?.digest) throw new Error(`Image manifest ${image} has no config`);
  const blob = await (await client.get(`blobs/${manifest.config.digest}`)).json() as {
    config?: { WorkingDir?: string; User?: string; Env?: string[] };
  };
  const env: Record<string, string> = {};
  for (const entry of blob.config?.Env ?? []) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return {
    workingDir: blob.config?.WorkingDir || null,
    user: blob.config?.User || null,
    env,
  };
}
