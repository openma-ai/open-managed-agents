// Deployment branding: product name, logo, favicon, login copy, and a theme
// stylesheet, configured by the operator (CONSOLE_BRANDING_DIR on main-node).
//
// When main-node serves the console it writes the settings into index.html as
// `<meta name="oma-branding">` together with the title, favicon, and
// stylesheet, so nothing changes after the first paint. Otherwise (a console
// on another origin, or the Vite dev server) the console fetches
// /branding/branding.json once and applies it; a 404 keeps the defaults.

import { useSyncExternalStore } from "react";

export interface Branding {
  productName: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  stylesheetUrl: string | null;
  loginTitle: string | null;
  loginSubtitle: string | null;
  /** True when a deployment supplied branding. */
  custom: boolean;
}

export const DEFAULT_BRANDING: Branding = {
  productName: "openma",
  logoUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
  stylesheetUrl: null,
  loginTitle: null,
  loginSubtitle: null,
  custom: false,
};

interface WireBranding {
  product_name?: unknown;
  logo_url?: unknown;
  logo_dark_url?: unknown;
  favicon_url?: unknown;
  stylesheet_url?: unknown;
  login_title?: unknown;
  login_subtitle?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** Same-origin paths only; branding never points the console at another site. */
const path = (v: unknown): string | null => {
  const s = str(v);
  return s && s.startsWith("/") && !s.startsWith("//") ? s : null;
};

export function parseBranding(raw: unknown): Branding {
  if (!raw || typeof raw !== "object") return DEFAULT_BRANDING;
  const w = raw as WireBranding;
  return {
    productName: str(w.product_name) ?? DEFAULT_BRANDING.productName,
    logoUrl: path(w.logo_url),
    logoDarkUrl: path(w.logo_dark_url),
    faviconUrl: path(w.favicon_url),
    stylesheetUrl: path(w.stylesheet_url),
    loginTitle: str(w.login_title),
    loginSubtitle: str(w.login_subtitle),
    custom: true,
  };
}

let current: Branding = DEFAULT_BRANDING;
const listeners = new Set<() => void>();

function setBranding(next: Branding) {
  current = next;
  for (const l of listeners) l();
}

function readMeta(): Branding | null {
  if (typeof document === "undefined") return null;
  const content = document.querySelector('meta[name="oma-branding"]')?.getAttribute("content");
  if (!content) return null;
  try {
    return parseBranding(JSON.parse(content));
  } catch {
    return null;
  }
}

/** Title, favicon, and stylesheet, for a page that was not branded by the server. */
export function applyBrandingToDocument(b: Branding, doc: Document = document) {
  if (!b.custom) return;
  doc.title = b.productName;
  if (b.faviconUrl) {
    doc.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]').forEach((el) => el.remove());
    const icon = doc.createElement("link");
    icon.rel = "icon";
    icon.href = b.faviconUrl;
    doc.head.appendChild(icon);
  }
  if (b.stylesheetUrl && !doc.querySelector(`link[data-oma-branding]`)) {
    const sheet = doc.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = b.stylesheetUrl;
    sheet.dataset.omaBranding = "";
    doc.head.appendChild(sheet);
  }
}

/** Called once at startup. */
export async function loadBranding(fetchImpl: typeof fetch = fetch): Promise<Branding> {
  const fromMeta = readMeta();
  if (fromMeta) {
    setBranding(fromMeta);
    return fromMeta;
  }
  try {
    const res = await fetchImpl("/branding/branding.json", { credentials: "same-origin" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return current;
    const next = parseBranding(await res.json());
    applyBrandingToDocument(next);
    setBranding(next);
    return next;
  } catch {
    return current;
  }
}

export function getBranding(): Branding {
  return current;
}

export function useBranding(): Branding {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}

/** Test hook. */
export function resetBrandingForTests(next: Branding = DEFAULT_BRANDING) {
  setBranding(next);
}
