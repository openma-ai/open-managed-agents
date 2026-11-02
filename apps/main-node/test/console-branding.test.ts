// Deployment branding for the console: branding.json validation, the
// /branding/ routes, and index.html rewriting when main-node serves the console.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";
import { brandIndexHtml, loadConsoleBranding } from "../../../packages/control-plane-node/src/lib/console-branding";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const INDEX = `<!DOCTYPE html><html><head>
    <title>Open Managed Agents</title>
    <link rel="icon" type="image/svg+xml" href="/logo.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.svg" />
    <link rel="stylesheet" href="/assets/app.css" />
  </head><body><div id="root"></div></body></html>`;

function brandingDir(manifest: unknown, files: Record<string, string> = {}): string {
  const dir = tempDir("oma-branding-");
  writeFileSync(join(dir, "branding.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const ACME = {
  product_name: "Acme <Agents>",
  logo: "logo.svg",
  favicon: "img/favicon.png",
  stylesheet: "theme.css",
  login: { title: "Sign in to Acme", subtitle: "Use your Acme account" },
};
const ACME_FILES = {
  "logo.svg": "<svg/>",
  "img/favicon.png": "png",
  "theme.css": ":root { --brand: #0055ff; }",
  "secret.txt": "nope",
};

async function boot(env: Record<string, string>) {
  const dir = tempDir("oma-branding-cp-");
  const config = loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
    ...env,
  });
  const cp = await createNodeControlPlane(await nodeDefaults(config));
  created.push(cp);
  return cp;
}

function consoleDir(): string {
  const dir = tempDir("oma-console-");
  writeFileSync(join(dir, "index.html"), INDEX);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.css"), "body{}");
  return dir;
}

const get = (cp: NodeControlPlane, path: string) => cp.fetch(new Request(`http://localhost${path}`));

describe("branding.json", () => {
  it("normalizes a full manifest to /branding/ URLs", () => {
    expect(loadConsoleBranding(brandingDir(ACME, ACME_FILES))).toEqual({
      product_name: "Acme <Agents>",
      logo_url: "/branding/logo.svg",
      logo_dark_url: null,
      favicon_url: "/branding/img/favicon.png",
      stylesheet_url: "/branding/theme.css",
      login_title: "Sign in to Acme",
      login_subtitle: "Use your Acme account",
    });
  });

  it("rejects configs that would fail at runtime", () => {
    expect(() => loadConsoleBranding(tempDir("oma-branding-empty-"))).toThrow(/no branding\.json/);
    expect(() => loadConsoleBranding(brandingDir("{"))).toThrow(/not valid JSON/);
    expect(() => loadConsoleBranding(brandingDir([]))).toThrow(/JSON object/);
    expect(() => loadConsoleBranding(brandingDir({ logo: "../etc/passwd" }))).toThrow(/inside the branding directory/);
    expect(() => loadConsoleBranding(brandingDir({ logo: "/abs.svg" }))).toThrow(/inside the branding directory/);
    expect(() => loadConsoleBranding(brandingDir({ logo: "missing.svg" }))).toThrow(/does not exist/);
    expect(() => loadConsoleBranding(brandingDir({ product_name: "x".repeat(61) }))).toThrow(/at most 60/);
    expect(() => loadConsoleBranding(brandingDir({ login: "nope" }))).toThrow(/login must be an object/);
  });

  it("rewrites index.html: escaped title, settings meta, favicon, and a last stylesheet", () => {
    const html = brandIndexHtml(INDEX, loadConsoleBranding(brandingDir(ACME, ACME_FILES)));
    expect(html).toContain("<title>Acme &lt;Agents&gt;</title>");
    expect(html).not.toContain('href="/logo.svg"');
    expect(html).not.toContain("apple-touch-icon");
    expect(html).toContain('<link rel="icon" href="/branding/img/favicon.png" />');
    const meta = /<meta name="oma-branding" content="([^"]*)"/.exec(html)![1]!;
    expect(JSON.parse(meta.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).product_name).toBe("Acme <Agents>");
    // The theme loads after the console's own CSS so its tokens win.
    expect(html.indexOf("/branding/theme.css")).toBeGreaterThan(html.indexOf("/assets/app.css"));
  });
});

describe("console branding routes", () => {
  it("serves the branding directory and a branded console", async () => {
    const cp = await boot({ CONSOLE_DIR: consoleDir(), CONSOLE_BRANDING_DIR: brandingDir(ACME, ACME_FILES) });

    const settings = await get(cp, "/branding/branding.json");
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ product_name: "Acme <Agents>", stylesheet_url: "/branding/theme.css" });
    expect(await (await get(cp, "/branding/theme.css")).text()).toContain("--brand: #0055ff");
    expect((await get(cp, "/branding/img/favicon.png")).status).toBe(200);
    expect((await get(cp, "/branding/missing.css")).status).toBe(404);
    expect((await get(cp, "/branding/%2e%2e/branding.json")).status).toBe(404);

    for (const path of ["/", "/index.html", "/agents/agent_1"]) {
      const page = await get(cp, path);
      expect(page.status, path).toBe(200);
      const html = await page.text();
      expect(html, path).toContain("<title>Acme &lt;Agents&gt;</title>");
      expect(html, path).toContain('href="/branding/theme.css"');
    }
    expect(await (await get(cp, "/assets/app.css")).text()).toBe("body{}");
  });

  it("serves branding to a console hosted elsewhere", async () => {
    const cp = await boot({ CONSOLE_BRANDING_DIR: brandingDir({ product_name: "Acme" }) });
    expect(await (await get(cp, "/branding/branding.json")).json()).toMatchObject({ product_name: "Acme", logo_url: null });
  });

  it("changes nothing without CONSOLE_BRANDING_DIR", async () => {
    const cp = await boot({ CONSOLE_DIR: consoleDir() });
    expect((await get(cp, "/branding/branding.json")).status).toBe(404);
    const html = await (await get(cp, "/")).text();
    expect(html).toContain("<title>Open Managed Agents</title>");
    expect(html).not.toContain("oma-branding");
  });

  it("refuses to start with a broken branding directory", async () => {
    await expect(boot({ CONSOLE_BRANDING_DIR: brandingDir({ logo: "missing.svg" }) })).rejects.toThrow(/does not exist/);
  });
});
