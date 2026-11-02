import { useEffect, useMemo, useState } from "react";
import { useScrollFade } from "../hooks/useScrollFade";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Avatar } from "../components/Avatar";
import { Logo } from "../components/Logo";

// Browser-side handler for `oma auth login`. The CLI opens this URL with
// callback + state in the query string, the user authenticates (cookie
// session) + picks one or more workspaces, and the page redirects back
// to the CLI's loopback server with N freshly-minted per-tenant tokens.
//
// Flow:
//   1. Read query params (callback, state, hostname, tenant?).
//   2. If no cookie session → bounce through /login with `next=` set to here.
//   3. Fetch /v1/oma/me to learn user + memberships.
//   4. Show approval UI: when N==1, just an Approve button; when N>1, a
//      checkbox list (defaults: ?tenant pre-selected, otherwise all).
//   5. POST /v1/oma/me/cli-tokens N times — one token per selected tenant.
//   6. window.location = `${callback}?tokens=<base64-json>&user=...&state=...`
//      — the array form so the CLI can populate every selected tenant's
//      profile in one round trip.
//
// Security notes:
//   - The `state` param is opaque to us; the CLI generates a nonce, stashes
//     it locally, and verifies it on the callback. We just round-trip it.
//   - The `callback` param MUST be a 127.0.0.1 / localhost URL — we reject
//     anything else so a malicious link can't trick a logged-in user into
//     handing tokens to an attacker-controlled host.
//   - One mint failure aborts the whole batch — partial tokens are
//     surfaced as an error, not silently delivered, so the user can see
//     exactly what landed.

interface MeResponse {
  user: { id: string; email: string; name: string | null } | null;
  tenant: { id: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
}

interface MintedToken {
  tenant_id: string;
  tenant_name: string;
  role: string;
  token: string;
  key_id: string;
}

type TenantMembership = MeResponse["tenants"][number];

interface UserIdentity {
  id?: string | null;
  email?: string | null;
  name?: string | null;
}

/** Human-readable user label for the consent copy. Falls through each
 *  identity field (trimmed, so "" / whitespace counts as missing) before
 *  landing on a stable placeholder — the sentence must never read
 *  "act on your behalf as ." when the session lacks a name/email/id. */
export function userDisplayLabel(user: UserIdentity | null | undefined): string {
  const name = user?.name?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  if (email) return email;
  const id = user?.id?.trim();
  if (id) return id;
  return "this user";
}

function isLoopback(callbackUrl: string): boolean {
  try {
    const u = new URL(callbackUrl);
    if (u.protocol !== "http:") return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

function tenantDisplayName(t: { id: string; name: string }): string {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) {
    return t.id;
  }
  return trimmed;
}

/** Browser-safe base64-encode of a UTF-8 JSON string. */
function encodeTokensParam(tokens: MintedToken[]): string {
  const json = JSON.stringify(tokens);
  // Use the binary-safe TextEncoder→btoa pattern; raw btoa() chokes on
  // multibyte characters that may appear in tenant names.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function CliLogin() {
  const { api } = useApi();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const callback = params.get("callback") ?? "";
  const state = params.get("state") ?? "";
  const hostname = params.get("hostname") ?? "this device";
  const requestedTenant = params.get("tenant") ?? "";
  const callbackOk = isLoopback(callback);

  const [me, setMe] = useState<MeResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [authNeeded, setAuthNeeded] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>("");
  const listFade = useScrollFade<HTMLDivElement>();

  // /v1/oma/me lookup via TQ. `enabled: callbackOk` defers the fetch until
  // we've validated the callback URL — an invalid callback short-circuits
  // straight to the error banner with no API roundtrip. /v1/oma/me's 401 is
  // already on useApi's silent-auth list so a pre-auth visit doesn't
  // produce a stray toast.
  const meQuery = useApiQuery<MeResponse>(
    callbackOk ? "/v1/oma/me" : null,
  );
  const loading = callbackOk ? meQuery.isLoading : false;

  // Apply the side effects of a successful /v1/oma/me — seed the default
  // workspace selection and stash the response for the render path.
  // Kept in an effect so a TQ refetch (tab focus, etc.) re-applies the
  // same defaults if data changes shape.
  useEffect(() => {
    if (!callbackOk) {
      setError("Invalid callback URL — only loopback addresses (127.0.0.1, localhost) are permitted.");
      return;
    }
    const res = meQuery.data;
    if (!res) return;
    setMe(res);
    // Default selection: respect ?tenant if it's a real membership,
    // otherwise select all (the "authorize CLI for everything" intent
    // most multi-tenant users have on first login).
    const ids = res.tenants.map((t) => t.id);
    if (requestedTenant && ids.includes(requestedTenant)) {
      setSelected(new Set([requestedTenant]));
    } else {
      setSelected(new Set(ids));
    }
  }, [callbackOk, meQuery.data, requestedTenant]);

  // /v1/oma/me failure handling: 401 → bounce to /login; anything else → show
  // the message inline. Matches the prior .catch() branch.
  useEffect(() => {
    const err = meQuery.error;
    if (!err) return;
    if (/401|Unauthorized/i.test(String((err as Error).message))) {
      setAuthNeeded(true);
    } else {
      setError(String((err as Error).message ?? err));
    }
  }, [meQuery.error]);

  const goLogin = () => {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  };

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!me) return;
    setSelected(new Set(me.tenants.map((t) => t.id)));
  };

  const selectNone = () => setSelected(new Set());

  const approve = async () => {
    if (selected.size === 0 || !me) return;
    setWorking(true);
    setError("");
    try {
      // Mint per-tenant tokens. Run in parallel — the endpoint is cheap
      // and the user already consented to all selected workspaces.
      const orderedSelection = me.tenants.filter((t) => selected.has(t.id));
      const minted = await Promise.all(
        orderedSelection.map(async (t) => {
          const res = await api<{ token: string; tenant_id: string; user_id: string; key_id: string }>(
            "/v1/oma/me/cli-tokens",
            {
              method: "POST",
              body: JSON.stringify({
                tenant_id: t.id,
                name: `CLI on ${hostname}`,
              }),
              // Force the mint call to operate against THIS tenant — the
              // sidebar's stored localStorage might point elsewhere, and
              // the auth middleware would otherwise mint for the wrong one.
              headers: { "x-active-tenant": t.id },
            },
          );
          return {
            tenant_id: res.tenant_id,
            tenant_name: t.name,
            role: t.role,
            token: res.token,
            key_id: res.key_id,
          } satisfies MintedToken;
        }),
      );
      const url = new URL(callback);
      url.searchParams.set("tokens", encodeTokensParam(minted));
      url.searchParams.set("user", me.user?.id ?? minted[0]?.tenant_id ?? "");
      url.searchParams.set("state", state);
      window.location.href = url.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  };

  const cancel = () => {
    if (callbackOk) {
      const url = new URL(callback);
      url.searchParams.set("error", "user_cancelled");
      url.searchParams.set("state", state);
      window.location.href = url.toString();
    } else {
      window.location.href = "/";
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-bg-surface border border-border rounded-xl p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <Logo size="md" />
          <div>
            <h1 className="font-display text-lg font-semibold">Authorize CLI</h1>
            <div className="text-xs text-fg-subtle">openma command-line client</div>
          </div>
        </div>

        {loading && <div className="text-sm text-fg-subtle">Checking session…</div>}

        {!loading && error && (
          <div className="bg-danger-subtle border border-danger/30 text-danger text-sm rounded-lg px-4 py-3 mb-4">
            {error}
          </div>
        )}

        {!loading && authNeeded && (
          <>
            <p className="text-sm text-fg-muted mb-4">
              Sign in to continue authorizing the CLI on{" "}
              <span className="font-mono text-fg">{hostname}</span>.
            </p>
            <Button onClick={goLogin} className="w-full">
              Sign in
            </Button>
          </>
        )}

        {!loading && !authNeeded && me && callbackOk && (
          <>
            <p className="text-sm text-fg-muted mb-2">
              The CLI on{" "}
              <span className="font-mono text-fg">{hostname}</span> wants to
              act on your behalf as{" "}
              <span className="font-mono text-fg">{userDisplayLabel(me.user)}</span>.
            </p>
            <p className="text-xs text-fg-subtle mb-5">
              Approving mints one API key per selected workspace — visible
              on the API Keys page, revocable at any time.
            </p>

            {me.tenants.length === 0 ? (
              <div className="text-sm text-danger mb-4">
                No workspaces found on this account.
              </div>
            ) : me.tenants.length === 1 ? (
              <div className="mb-5">
                <div className="console-cli-workspace-heading">Workspace</div>
                <div className="console-cli-workspace-list">
                  {me.tenants.map((t) => {
                    const display = tenantDisplayName(t);
                    return (
                      <div
                        key={t.id}
                        className="console-cli-workspace-item"
                        data-static="true"
                      >
                        <Avatar name={display} size="xs" squared />
                        <WorkspaceCopy tenant={t} display={display} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mb-5">
                <div className="console-cli-workspace-heading">
                  <span>
                    Workspaces ({selected.size}/{me.tenants.length})
                  </span>
                  <span className="console-cli-workspace-actions">
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={selectAll}
                      className="console-cli-workspace-action"
                    >
                      All
                    </Button>
                    <span aria-hidden="true">·</span>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={selectNone}
                      className="console-cli-workspace-action"
                    >
                      None
                    </Button>
                  </span>
                </div>
                <div
                  ref={listFade.ref}
                  className={`console-cli-workspace-list console-scroll-fade ${listFade.className}`}
                >
                  {me.tenants.map((t) => {
                    const isSelected = selected.has(t.id);
                    const display = tenantDisplayName(t);
                    return (
                      <Label
                        key={t.id}
                        className="console-cli-workspace-item"
                        data-selected={isSelected ? "true" : undefined}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggle(t.id)}
                          aria-label={`${display} (${t.role})`}
                        />
                        <Avatar name={display} size="xs" squared />
                        <WorkspaceCopy tenant={t} display={display} />
                      </Label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={approve}
                disabled={working || selected.size === 0 || me.tenants.length === 0}
                className="flex-1"
              >
                {working
                  ? "Authorizing…"
                  : me.tenants.length <= 1
                    ? "Approve"
                    : `Approve ${selected.size} workspace${selected.size === 1 ? "" : "s"}`}
              </Button>
              <Button variant="ghost"
                onClick={cancel}
                disabled={working}
                className="inline-flex items-center justify-center px-4 py-2.5 min-h-11 sm:min-h-0 rounded-lg border border-border text-sm text-fg-muted hover:bg-bg disabled:opacity-40"
              >
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Primary workspace name plus the de-emphasized role/id line shared by the
 *  single- and multi-workspace views. The raw tenant id only appears in the
 *  secondary line for named workspaces (mono, truncated, low opacity); when
 *  the name falls back to the id it is already the primary label. */
function WorkspaceCopy({
  tenant,
  display,
}: {
  tenant: TenantMembership;
  display: string;
}) {
  return (
    <span className="console-cli-workspace-copy">
      <span className="console-cli-workspace-name">{display}</span>
      <span className="console-cli-workspace-meta">
        <span className="console-cli-workspace-role">{tenant.role}</span>
        {display !== tenant.id && (
          <span className="console-cli-workspace-id" title={tenant.id}>
            {tenant.id}
          </span>
        )}
      </span>
    </span>
  );
}

