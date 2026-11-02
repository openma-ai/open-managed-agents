// Deployment branding for the console: product name, logo, favicon, login
// copy, and a stylesheet that overrides the theme tokens. A deployment points
// CONSOLE_BRANDING_DIR at a directory holding `branding.json` and the files it
// names:
//
//   {
//     "product_name": "Acme Agents",
//     "logo": "logo.svg",            // optional, shown on sign-in pages
//     "logo_dark": "logo-dark.svg",  // optional, dark theme variant
//     "favicon": "favicon.png",      // optional
//     "stylesheet": "theme.css",     // optional, loaded after the console CSS
//     "login": { "title": "Sign in to Acme", "subtitle": "Use your Acme account" }
//   }
//
// The directory is served under /branding/. When the control plane also
// serves the console (CONSOLE_DIR), index.html is rewritten so the title,
// favicon, stylesheet, and settings are in place before the first paint.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** What the console reads; URLs are absolute paths under /branding/. */
export interface ConsoleBranding {
  product_name: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  stylesheet_url: string | null;
  login_title: string | null;
  login_subtitle: string | null;
}

export const BRANDING_PATH = "/branding";
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export class ConsoleBrandingError extends Error {}

function text(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new ConsoleBrandingError(`branding.json: ${field} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ConsoleBrandingError(`branding.json: ${field} may be at most ${max} characters`);
  return trimmed;
}

/** A path inside the branding directory, by name only; no `..`, no absolute paths. */
export function safeBrandingFile(name: string): boolean {
  return FILE_RE.test(name) && !name.split("/").some((p) => p === "." || p === "..");
}

function file(dir: string, value: unknown, field: string): string | null {
  const name = text(value, field, 200);
  if (name === null) return null;
  if (!safeBrandingFile(name)) throw new ConsoleBrandingError(`branding.json: ${field} must be a file name inside the branding directory`);
  const path = join(dir, name);
  if (!existsSync(path) || !statSync(path).isFile()) throw new ConsoleBrandingError(`branding.json: ${field} names ${name}, which does not exist`);
  return `${BRANDING_PATH}/${name}`;
}

/** Reads and validates `<dir>/branding.json`. Throws ConsoleBrandingError on a bad config. */
export function loadConsoleBranding(dir: string): ConsoleBranding {
  const root = resolve(dir);
  const manifest = join(root, "branding.json");
  if (!existsSync(manifest)) throw new ConsoleBrandingError(`CONSOLE_BRANDING_DIR has no branding.json: ${root}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (error) {
    throw new ConsoleBrandingError(`branding.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConsoleBrandingError("branding.json must be a JSON object");
  const b = raw as Record<string, unknown>;
  const login = b.login === undefined ? {} : b.login;
  if (!login || typeof login !== "object" || Array.isArray(login)) throw new ConsoleBrandingError("branding.json: login must be an object");
  const l = login as Record<string, unknown>;
  return {
    product_name: text(b.product_name, "product_name", 60),
    logo_url: file(root, b.logo, "logo"),
    logo_dark_url: file(root, b.logo_dark, "logo_dark"),
    favicon_url: file(root, b.favicon, "favicon"),
    stylesheet_url: file(root, b.stylesheet, "stylesheet"),
    login_title: text(l.title, "login.title", 120),
    login_subtitle: text(l.subtitle, "login.subtitle", 240),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Puts the branding into the console's index.html: title, favicon, the
 * stylesheet (after every other stylesheet, so its tokens win), and a
 * `<meta name="oma-branding">` the console reads without a round trip.
 */
export function brandIndexHtml(html: string, branding: ConsoleBranding): string {
  let out = html;
  if (branding.product_name) {
    out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(branding.product_name)}</title>`);
  }
  const head: string[] = [`<meta name="oma-branding" content="${escapeHtml(JSON.stringify(branding))}" />`];
  if (branding.favicon_url) {
    out = out.replace(/<link\s+rel="(icon|apple-touch-icon|mask-icon)"[^>]*>\s*/g, "");
    head.push(`<link rel="icon" href="${escapeHtml(branding.favicon_url)}" />`);
  }
  if (branding.stylesheet_url) head.push(`<link rel="stylesheet" href="${escapeHtml(branding.stylesheet_url)}" />`);
  return out.replace("</head>", `    ${head.join("\n    ")}\n  </head>`);
}

/** Root for serveStatic, which wants a path relative to the working directory. */
export function staticRoot(dir: string): string {
  return isAbsolute(dir) ? relative(process.cwd(), dir) || "." : dir;
}
