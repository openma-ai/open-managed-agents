import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

const OTHER = "__other__";

/** The GitLab instance of a form: one the deployment offers or this
 * workspace linked before, or "other" for a free URL. */
function useGitLabInstance(): { url: string; field: ReactNode } {
  const { t } = useI18n();
  const b = t.matter.bonds;
  const [instances, setInstances] = useState<string[]>([]);
  const [instance, setInstance] = useState(OTHER);
  const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
  useEffect(() => {
    let live = true;
    matter<{ instances?: string[] }>("/connect/gitlab")
      .then((r) => {
        const known = r.instances ?? [];
        if (!live || known.length === 0) return;
        setInstances(known);
        setInstance(known[0]!);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const field = (
    <>
      <Label htmlFor={instances.length > 0 ? "gitlab-instance" : "gitlab-url"}>{b.gitlabUrl}</Label>
      {instances.length > 0 && (
        <Select value={instance} onValueChange={setInstance}>
          <SelectTrigger id="gitlab-instance" aria-label={b.gitlabUrl} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {instances.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
            <SelectItem value={OTHER}>{b.otherInstance}</SelectItem>
          </SelectContent>
        </Select>
      )}
      {instance === OTHER && (
        <Input id="gitlab-url" aria-label={b.gitlabUrl} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      )}
    </>
  );
  return { url: instance === OTHER ? baseUrl : instance, field };
}

export type GitLabMode = "create" | "paste";

/** What creating a project bot asks for; `userToken` is sent once and dropped. */
interface GitLabBotForm {
  project: string;
  preset: "read" | "comment";
  expiresAt: string;
  userToken: string;
}

const emptyBotForm: GitLabBotForm = { project: "", preset: "read", expiresAt: "", userToken: "" };

/** The request body for a project bot: no expiry means the server's default. */
const botBody = (form: GitLabBotForm) => ({
  project: form.project.trim(),
  preset: form.preset,
  ...(form.expiresAt === "" ? {} : { expiresAt: form.expiresAt }),
  userToken: form.userToken,
});

const botFormReady = (form: GitLabBotForm) => form.project.trim() !== "" && form.userToken.trim() !== "";

function GitLabBotFields({ form, onChange }: { form: GitLabBotForm; onChange: (form: GitLabBotForm) => void }) {
  const { t } = useI18n();
  const b = t.matter.bonds;
  return (
    <>
      <p className="text-fg-muted">{b.gitlabBotHint}</p>
      <Label htmlFor="gitlab-project">{b.gitlabProject}</Label>
      <Input
        id="gitlab-project"
        placeholder="group/name"
        value={form.project}
        onChange={(e) => onChange({ ...form, project: e.target.value })}
      />
      <Label id="gitlab-preset-label">{b.gitlabPreset}</Label>
      <RadioGroup
        aria-labelledby="gitlab-preset-label"
        value={form.preset}
        onValueChange={(preset) => onChange({ ...form, preset: preset as GitLabBotForm["preset"] })}
        className="gap-2"
      >
        {(
          [
            ["read", b.gitlabPresetRead],
            ["comment", b.gitlabPresetComment],
          ] as const
        ).map(([value, text]) => (
          <div key={value} className="flex items-center gap-2">
            <RadioGroupItem id={`gitlab-preset-${value}`} value={value} aria-label={text} />
            <Label htmlFor={`gitlab-preset-${value}`} className="font-normal">
              {text}
            </Label>
          </div>
        ))}
      </RadioGroup>
      <Label htmlFor="gitlab-expires">{b.gitlabExpires}</Label>
      <Input
        id="gitlab-expires"
        type="date"
        value={form.expiresAt}
        onChange={(e) => onChange({ ...form, expiresAt: e.target.value })}
      />
      <Label htmlFor="gitlab-user-token">{b.gitlabUserToken}</Label>
      <Input
        id="gitlab-user-token"
        type="password"
        autoComplete="off"
        value={form.userToken}
        onChange={(e) => onChange({ ...form, userToken: e.target.value })}
      />
    </>
  );
}

/** "Create a bot for a project" or "Paste a bot token". */
function GitLabModeTabs({
  mode,
  onMode,
  create,
  paste,
}: {
  mode: GitLabMode;
  onMode: (mode: GitLabMode) => void;
  create: ReactNode;
  paste: ReactNode;
}) {
  const { t } = useI18n();
  const b = t.matter.bonds;
  return (
    <Tabs value={mode} onValueChange={(v) => onMode(v as GitLabMode)}>
      <TabsList>
        <TabsTrigger value="create">{b.gitlabModeCreate}</TabsTrigger>
        <TabsTrigger value="paste">{b.gitlabModePaste}</TabsTrigger>
      </TabsList>
      <TabsContent value="create" className="space-y-2">
        {create}
      </TabsContent>
      <TabsContent value="paste" className="space-y-2">
        {paste}
      </TabsContent>
    </Tabs>
  );
}

function GitLabPastedToken({ token, onChange }: { token: string; onChange: (token: string) => void }) {
  const { t } = useI18n();
  const b = t.matter.bonds;
  return (
    <>
      <Label htmlFor="gitlab-token">{b.gitlabToken}</Label>
      <Input id="gitlab-token" type="password" autoComplete="off" value={token} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

/**
 * Link a GitLab instance: create a project bot with the user's own token
 * (the default), or paste a bot token. Shows the webhook to add, once.
 */
export function GitLabLinker({ onLinked }: { onLinked: (bond: string) => Promise<void> | void }) {
  const { t } = useI18n();
  const b = t.matter.bonds;
  const { url, field } = useGitLabInstance();
  const [mode, setMode] = useState<GitLabMode>("create");
  const [bot, setBot] = useState<GitLabBotForm>(emptyBotForm);
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
        await matter<{ id: string; webhookUrl: string; webhookSecret: string }>(
          mode === "create" ? "/connect/gitlab/bot" : "/connect/gitlab",
          {
            method: "POST",
            body: JSON.stringify(mode === "create" ? { baseUrl: url, ...botBody(bot) } : { baseUrl: url, token }),
          },
        ),
      );
      // The user's token was for this one call.
      setBot((form) => ({ ...form, userToken: "" }));
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
  const ready = mode === "create" ? botFormReady(bot) : token.trim() !== "";
  return (
    <div className="space-y-2 text-sm">
      {field}
      <GitLabModeTabs
        mode={mode}
        onMode={setMode}
        create={<GitLabBotFields form={bot} onChange={setBot} />}
        paste={<GitLabPastedToken token={token} onChange={setToken} />}
      />
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <Button size="sm" onClick={() => void link()} disabled={busy || !ready}>
        {mode === "create" ? b.createBot : b.link}
      </Button>
    </div>
  );
}

/** Give a GitLab Bond a new token in place: its webhook and Loops stay. */
export function GitLabTokenReplacer({
  connectionId,
  onReplaced,
}: {
  /** The connection id (`gitlab-…`), without the `gitlab:` Bond prefix. */
  connectionId: string;
  onReplaced: () => void;
}) {
  const { t } = useI18n();
  const b = t.matter.bonds;
  const [mode, setMode] = useState<GitLabMode>("create");
  const [bot, setBot] = useState<GitLabBotForm>(emptyBotForm);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function replace() {
    setBusy(true);
    setError(null);
    try {
      await matter(`/connect/gitlab/${encodeURIComponent(connectionId)}/token`, {
        method: "PUT",
        body: JSON.stringify(mode === "create" ? botBody(bot) : { token }),
      });
      setBot(emptyBotForm);
      setToken("");
      onReplaced();
    } catch (err) {
      setError(err instanceof MatterError ? err.message : b.linkFailed);
    } finally {
      setBusy(false);
    }
  }

  const ready = mode === "create" ? botFormReady(bot) : token.trim() !== "";
  return (
    <div className="space-y-2 text-sm">
      <GitLabModeTabs
        mode={mode}
        onMode={setMode}
        create={<GitLabBotFields form={bot} onChange={setBot} />}
        paste={<GitLabPastedToken token={token} onChange={setToken} />}
      />
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <Button size="sm" onClick={() => void replace()} disabled={busy || !ready}>
        {b.replace}
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
