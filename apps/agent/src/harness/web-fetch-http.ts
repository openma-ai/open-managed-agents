/**
 * web_fetch HTTP: manual redirects with per-hop environment allowed_hosts checks.
 */

import { httpFetchErrorMessage, mergeAbortSignals } from "./tool-http-fetch";

export const WEB_FETCH_TIMEOUT_MS = 20_000;
export const WEB_FETCH_RAW_TIMEOUT_MS = 30_000;

/** Environment networking fields applied to web_fetch outbound requests. */
export interface WebFetchNetworking {
  type?: "unrestricted" | "limited" | string;
  allowed_hosts?: string[];
}

export class WebFetchHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebFetchHttpError";
  }
}

function normalizeHostname(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

function isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
  const host = normalizeHostname(hostname);
  return allowedHosts.some((allowed) => {
    const a = normalizeHostname(allowed);
    return host === a || host.endsWith(`.${a}`);
  });
}

function assertHttpProtocol(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchHttpError(`URL protocol "${url.protocol}" is not allowed (only http/https)`);
  }
}

export function assertWebFetchUrlAllowed(
  urlInput: string | URL,
  networking?: WebFetchNetworking | null,
): URL {
  let url: URL;
  try {
    url = typeof urlInput === "string" ? new URL(urlInput) : new URL(urlInput.toString());
  } catch {
    throw new WebFetchHttpError("Invalid URL");
  }

  assertHttpProtocol(url);

  if (networking?.type === "limited") {
    const allowed = networking.allowed_hosts ?? [];
    const hostname = url.hostname;
    if (!isAllowedHost(hostname, allowed)) {
      throw new WebFetchHttpError(
        `Host "${hostname}" is not allowed. Allowed hosts: ${allowed.join(", ") || "(none)"}`,
      );
    }
  }

  return url;
}

export function webFetchGuardError(
  url: string,
  networking?: WebFetchNetworking,
): string | null {
  try {
    assertWebFetchUrlAllowed(url, networking);
    return null;
  } catch (err) {
    return `Error: ${(err as WebFetchHttpError).message}`;
  }
}

export function webFetchHttpErrorMessage(err: unknown, timeoutMs = WEB_FETCH_TIMEOUT_MS): string {
  if (err instanceof WebFetchHttpError) return err.message;
  return httpFetchErrorMessage(err, timeoutMs);
}

export interface WebFetchHttpOptions {
  networking?: WebFetchNetworking | null;
  timeoutMs?: number;
  abortSignal?: AbortSignal | null;
  maxRedirects?: number;
}

const DEFAULT_MAX_REDIRECTS = 10;

export async function fetchWebFetchUrl(
  input: string | URL,
  init: RequestInit = {},
  options: WebFetchHttpOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = mergeAbortSignals([init.signal, options.abortSignal, timeoutSignal]);

  let currentUrl = typeof input === "string" ? input : input.toString();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = assertWebFetchUrlAllowed(currentUrl, options.networking);

    const response = await fetch(url.toString(), {
      ...init,
      redirect: "manual",
      signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return response;
      }
      currentUrl = new URL(location, url).toString();
      continue;
    }

    return response;
  }

  throw new WebFetchHttpError(`Too many redirects (max ${maxRedirects})`);
}
