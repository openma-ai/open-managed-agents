import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { FeishuIcon, GitLabIcon } from "../../components/icons";
import { useI18n } from "../../i18n";
import { matter, MatterError, type SetupReport } from "../../lib/matter";

/** Shared pieces of the Matter pages (Loops and Bonds). */

export type Provider = "feishu" | "gitlab";

export function ProviderIcon({ provider, className = "size-4" }: { provider: string; className?: string }) {
  return provider === "gitlab" ? <GitLabIcon className={className} /> : <FeishuIcon className={className} />;
}

export type Tone = "success" | "warning" | "danger" | "muted";

/** Same shape as the status pills of the other list pages. */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const cls = {
    success: "bg-success-subtle text-success",
    warning: "bg-warning-subtle text-warning",
    danger: "bg-danger-subtle text-danger",
    muted: "bg-bg-surface text-fg-subtle",
  }[tone];
  return <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${cls}`}>{children}</span>;
}

/** The message to show for a failed Matter call. */
export function useMatterError() {
  const { t } = useI18n();
  return (err: unknown) =>
    err instanceof MatterError && err.code === "matter_not_configured" ? t.matter.notConfigured : t.matter.loadFailed;
}

/** What a Feishu app still needs, with links to fix it in the developer console. */
export function SetupResult({ setup }: { setup?: SetupReport }) {
  const { t } = useI18n();
  const b = t.matter.bonds;
  if (setup === undefined) return <p className="text-xs text-fg-subtle">{b.setupUnknown}</p>;
  if (setup.ready) return <p className="text-xs text-success">{b.setupReady}</p>;
  const links = (
    [
      ["scopes", b.linkScopes],
      ["events", b.linkEvents],
      ["bot", b.linkBot],
      ["publish", b.linkPublish],
    ] as const
  ).flatMap(([key, text]) => (setup.links?.[key] ? [{ href: setup.links[key]!, text }] : []));
  return (
    <div className="rounded-md border border-warning/30 bg-warning-subtle/40 px-3 py-2 text-xs">
      <p className="font-medium text-warning">{b.setupFixes}</p>
      <ul className="mt-1 list-disc pl-4 text-fg-muted">
        {setup.problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      {links.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {links.map((l) => (
            <a key={l.text} href={l.href} target="_blank" rel="noopener noreferrer" className="font-medium text-brand underline">
              {l.text} ↗
            </a>
          ))}
        </p>
      )}
    </div>
  );
}

const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

type Registration =
  | { status: "pending"; url: string; qrSvg: string }
  | { status: "registered"; appId: string }
  | { status: "expired" | "denied" }
  | { status: "failed"; reason?: string };

/** Link a Feishu app: scan, confirm, and it becomes the Bond `feishu:<appId>`. */
export function FeishuLinker({ onLinked }: { onLinked: (bond: string) => Promise<void> | void }) {
  const { t } = useI18n();
  const b = t.matter.bonds;
  const [status, setStatus] = useState<Registration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const poll = (id: string) => {
    timer.current = setTimeout(async () => {
      try {
        const next = await matter<Registration>(`/connect/feishu/registrations/${encodeURIComponent(id)}`);
        setStatus(next);
        if (next.status === "pending") poll(id);
        else if (next.status === "registered") await onLinked(`feishu:${next.appId}`);
      } catch {
        setError(b.linkFailed);
      }
    }, 3000);
  };

  async function start() {
    clearTimeout(timer.current);
    setBusy(true);
    setError(null);
    try {
      const { id, status: first } = await matter<{ id: string; status: Registration }>("/connect/feishu/registrations", {
        method: "POST",
        body: "{}",
      });
      setStatus(first);
      if (first.status === "pending") poll(id);
    } catch {
      setError(b.linkFailed);
    } finally {
      setBusy(false);
    }
  }

  const failure =
    error ??
    (status?.status === "expired"
      ? b.expired
      : status?.status === "denied"
        ? b.denied
        : status?.status === "failed"
          ? b.linkFailed
          : null);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-fg-muted">{b.scan}</p>
      {status?.status === "pending" ? (
        <div className="flex items-start gap-4">
          <img src={svgDataUrl(status.qrSvg)} alt="" width={160} height={160} className="rounded-md border border-border bg-white p-1.5" />
          <div className="space-y-2">
            <p className="text-fg-muted">{b.waiting}</p>
            <a href={status.url} target="_blank" rel="noopener noreferrer" className="text-brand underline">
              {b.openInFeishu} ↗
            </a>
          </div>
        </div>
      ) : (
        <Button size="sm" onClick={() => void start()} disabled={busy}>
          {b.showQr}
        </Button>
      )}
      {failure && (
        <p role="alert" className="text-danger">
          {failure}
        </p>
      )}
    </div>
  );
}

/** Link a GitLab instance with a bot token; shows the webhook to add, once. */
export function GitLabLinker({ onLinked }: { onLinked: (bond: string) => Promise<void> | void }) {
  const { t } = useI18n();
  const b = t.matter.bonds;
  const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; webhookUrl: string; webhookSecret: string } | null>(null);
  const absolute = useMemo(
    () => (result && result.webhookUrl.startsWith("/") ? `${window.location.origin}${result.webhookUrl}` : result?.webhookUrl),
    [result],
  );

  async function link() {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await matter<{ id: string; webhookUrl: string; webhookSecret: string }>("/connect/gitlab", {
          method: "POST",
          body: JSON.stringify({ baseUrl, token }),
        }),
      );
    } catch (err) {
      setError(err instanceof MatterError ? err.message : b.linkFailed);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-fg-muted">{b.webhookHint}</p>
        <Label>{b.webhookUrl}</Label>
        <Input readOnly value={absolute ?? ""} onFocus={(e) => e.currentTarget.select()} />
        <Label>{b.webhookSecret}</Label>
        <Input readOnly value={result.webhookSecret} onFocus={(e) => e.currentTarget.select()} />
        <Button size="sm" onClick={() => void onLinked(`gitlab:${result.id}`)}>
          {b.done}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <Label htmlFor="gitlab-url">{b.gitlabUrl}</Label>
      <Input id="gitlab-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      <Label htmlFor="gitlab-token">{b.gitlabToken}</Label>
      <Input id="gitlab-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <Button size="sm" onClick={() => void link()} disabled={busy || token.trim() === ""}>
        {b.link}
      </Button>
    </div>
  );
}

/** A settings-page section: the same card the Environment page uses. */
export function MatterSection({
  title,
  hint,
  action,
  flush = false,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  /** Rows that run edge to edge instead of a padded body. */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="console-settings-section">
      <header className="console-settings-section-header">
        <div className="min-w-0">
          <h2>{title}</h2>
          {hint && <p>{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {flush ? <div className="divide-y divide-border">{children}</div> : <div className="console-settings-section-body">{children}</div>}
    </section>
  );
}

/** The compact title row of a Matter detail page: icon, name, a line under it, status. */
export function MatterTitle({
  provider,
  title,
  subtitle,
  status,
}: {
  provider: string;
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <ProviderIcon provider={provider} className="size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-fg">{title}</p>
        {subtitle && <p className="truncate text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {status}
    </div>
  );
}

/** Loading / error placeholder of a Matter page. */
export function MatterNotice({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "danger" }) {
  return (
    <p role={tone === "danger" ? "alert" : undefined} className={tone === "danger" ? "text-sm text-danger" : "text-sm text-fg-muted"}>
      {children}
    </p>
  );
}

/** Route-safe id of a Bond (`feishu:cli_x`), and back. */
export const bondPath = (id: string) => `/bonds/${encodeURIComponent(id)}`;
export const loopPath = (id: string) => `/loops/${encodeURIComponent(id)}`;
