import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type { A1FormStep, A1InstallLink } from "../api/types";
import { SecretInput, TextInput } from "../../components/Input";
import { Combobox } from "../../components/Combobox";
import { Field } from "../../components/Field";
import { formatRelative } from "../../lib/format";

const api = new IntegrationsApi();

interface AgentOption {
  id: string;
  name: string;
  created_at?: string;
}

interface EnvironmentOption {
  id: string;
  name: string;
  created_at?: string;
}

interface PublishWizardProps {
  loadAgents: () => Promise<AgentOption[]>;
  loadEnvironments: () => Promise<EnvironmentOption[]>;
}

type Step = "pick" | "a1-credentials" | "a1-install";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "pick", label: "Configure" },
  { id: "a1-credentials", label: "Credentials" },
  { id: "a1-install", label: "Install" },
];

export function IntegrationsSlackPublishWizard({
  loadAgents,
  loadEnvironments,
}: PublishWizardProps) {
  const [search, setSearch] = useSearchParams();
  const preselectedAgent = search.get("agent_id") ?? "";
  const resumePubId = search.get("pub");

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [envs, setEnvs] = useState<EnvironmentOption[]>([]);
  const [agentId, setAgentId] = useState(preselectedAgent);
  const [envId, setEnvId] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [personaAvatar, setPersonaAvatar] = useState("");

  const [step, setStep] = useState<Step>("pick");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while we hydrate from `?pub=` so we don't render the (empty) "pick"
  // step while we're still resolving the existing publication's state.
  const [hydrating, setHydrating] = useState<boolean>(Boolean(resumePubId));

  const [a1Form, setA1Form] = useState<A1FormStep | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [a1InstallLink, setA1InstallLink] = useState<A1InstallLink | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [a, e] = await Promise.all([loadAgents(), loadEnvironments()]);
        setAgents(a);
        setEnvs(e);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [loadAgents, loadEnvironments]);

  // Refresh-resume hydration. When the user lands with `?pub=<id>` (set by
  // a previous wizard run via replaceState) we re-issue a fresh formToken
  // server-side and re-derive the wizard step from the publication's
  // current status. Server is the source of truth — no sessionStorage.
  useEffect(() => {
    if (!resumePubId) return;
    let cancelled = false;
    void (async () => {
      try {
        const pub = await api.slack.getPublication(resumePubId);
        if (cancelled) return;
        // Already-live pubs belong on the list page, not the wizard.
        if (pub.status === "live") {
          window.location.href = "/integrations/slack";
          return;
        }
        if (pub.status === "unpublished" || pub.status === "needs_reauth") {
          // Drop the bad ?pub= so the wizard re-renders fresh.
          search.delete("pub");
          setSearch(search, { replace: true });
          setHydrating(false);
          return;
        }
        // Re-issue a fresh formToken for the existing shell. Server validates
        // ownership; we only re-render the wizard here.
        const form = await api.slack.reissueFormToken(resumePubId, returnUrl);
        if (cancelled) return;
        setA1Form(form);
        setAgentId(pub.agent_id);
        setEnvId(pub.environment_id);
        setPersonaName(pub.persona.name);
        if (pub.persona.avatarUrl) setPersonaAvatar(pub.persona.avatarUrl);
        // pending_setup / credentials_filled → step 2; awaiting_install → 3.
        // Slack's adapter elides credentials_filled (jumps to awaiting_install
        // on first setCredentials), so 'awaiting_install' is the install-step
        // signal. We always start on credentials so the user can re-paste —
        // the install link will be re-issued after submitCredentials.
        setStep("a1-credentials");
      } catch (err) {
        if (!cancelled) {
          // Resume failed (e.g. 404 / 409). Drop the bad ?pub= so the wizard
          // falls back to the fresh-pick path.
          search.delete("pub");
          setSearch(search, { replace: true });
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // resumePubId pinned at first render — we don't want the URL replace
    // below to re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default persona name to the chosen agent's name. Skip once the user has
  // edited the field — otherwise clearing the input would refill it from the
  // effect's personaName dep, making the field feel un-clearable.
  const personaEditedRef = useRef(false);
  useEffect(() => {
    if (personaEditedRef.current) return;
    if (agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (agent) setPersonaName(agent.name);
    }
  }, [agentId, agents]);

  const returnUrl = `${window.location.origin}/integrations/slack`;

  // Stamp the active publication id into the URL so a refresh resumes from
  // the same row instead of starting fresh. Pure URL state — no storage.
  function pinPublicationToUrl(publicationId: string) {
    const url = new URL(window.location.href);
    if (url.searchParams.get("pub") === publicationId) return;
    url.searchParams.set("pub", publicationId);
    window.history.replaceState({}, "", url.toString());
  }

  async function startPublish() {
    if (!agentId || !envId || !personaName) {
      setError("Pick agent, environment, and persona name first");
      return;
    }
    setError(null);
    setWorking(true);
    try {
      const f = await api.slack.startA1({
        agentId,
        environmentId: envId,
        personaName,
        personaAvatarUrl: personaAvatar || null,
        returnUrl,
      });
      setA1Form(f);
      setStep("a1-credentials");
      if (f.publicationId) pinPublicationToUrl(f.publicationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function submitA1Credentials() {
    if (!a1Form || !clientId || !clientSecret || !signingSecret) return;
    setError(null);
    setWorking(true);
    try {
      const link = await api.slack.submitCredentials({
        formToken: a1Form.formToken,
        clientId,
        clientSecret,
        signingSecret,
      });
      setA1InstallLink(link);
      setStep("a1-install");
      if (link.publicationId) pinPublicationToUrl(link.publicationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-4 sm:px-8 lg:px-10 py-8 lg:py-10">
        <Link
          to="/integrations/slack"
          className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          ← Slack integrations
        </Link>

        <header className="mt-3 mb-6">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
            Publish agent to Slack
          </h1>
          <p className="mt-1.5 text-[14px] text-fg-muted">
            Make this agent a teammate in your Slack workspace.
          </p>
        </header>

        <StepIndicator current={step} />

        {/* Post-install banner — set by the gateway redirect when Slack OAuth
            completes. install=ok always shows green check; capability probe
            kind=slack_mcp + probe_ok=0 adds a yellow warning with a deeplink
            to flip the MCP toggle the user almost certainly missed. */}
        {search.get("install") === "ok" && (
          <div className="mb-4 space-y-2">
            <div className="rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-[13px] text-success font-medium">
              ✓ Installed in Slack. Publication: <code>{search.get("publication_id")}</code>
            </div>
            {search.get("probe_kind") === "slack_mcp" && search.get("probe_ok") === "0" && (
              <div className="rounded-md border border-warning/30 bg-warning-subtle px-3.5 py-3 text-[13px]">
                <div className="font-medium text-fg mb-1">⚠ Slack MCP server access is OFF</div>
                <p className="text-fg-muted text-[12px] leading-relaxed mb-2">
                  {search.get("probe_message") ??
                    "The agent is installed but Slack's MCP server is rejecting our token. Flip the toggle to enable typed mcp__slack__* tools."}
                </p>
                {search.get("probe_fix_url") && (
                  <a
                    href={search.get("probe_fix_url")!}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md border border-warning/40 text-fg hover:bg-warning-subtle/70 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                  >
                    Open Agents &amp; AI Apps page ↗
                  </a>
                )}
              </div>
            )}
            {search.get("probe_kind") === "slack_mcp" && search.get("probe_ok") === "1" && (
              <div className="rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-[12px] text-success">
                ✓ Slack MCP server access verified — agent can use typed slack tools.
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger">
            {error}
          </div>
        )}

        {hydrating && (
          <div className="rounded-md border border-border bg-bg-surface/30 px-3.5 py-3 text-[13px] text-fg-muted">
            Resuming in-progress install…
          </div>
        )}

        {!hydrating && step === "pick" && (
          <PickStep
            agents={agents}
            envs={envs}
            agentId={agentId}
            setAgentId={setAgentId}
            envId={envId}
            setEnvId={setEnvId}
            personaName={personaName}
            setPersonaName={(v) => { personaEditedRef.current = true; setPersonaName(v); }}
            personaAvatar={personaAvatar}
            setPersonaAvatar={setPersonaAvatar}
            working={working}
            onContinue={startPublish}
          />
        )}

        {!hydrating && step === "a1-credentials" && a1Form && (
          <A1CredentialsStep
            form={a1Form}
            agentName={agents.find((a) => a.id === agentId)?.name ?? agentId}
            envName={envs.find((e) => e.id === envId)?.name ?? envId}
            personaName={personaName}
            clientId={clientId}
            setClientId={setClientId}
            clientSecret={clientSecret}
            setClientSecret={setClientSecret}
            signingSecret={signingSecret}
            setSigningSecret={setSigningSecret}
            working={working}
            onSubmit={submitA1Credentials}
            onBack={() => setStep("pick")}
          />
        )}

        {!hydrating && step === "a1-install" && a1InstallLink && (
          <A1InstallStep link={a1InstallLink} onBack={() => setStep("a1-credentials")} />
        )}
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const currentIdx = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center gap-2 mb-7" aria-label="Wizard progress">
      {STEPS.map((s, i) => {
        const state =
          i < currentIdx ? "done" : i === currentIdx ? "current" : "todo";
        return (
          <li key={s.id} className="flex items-center gap-2 flex-1 last:flex-none">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-mono font-medium shrink-0 ${
                  state === "done"
                    ? "bg-brand text-brand-fg"
                    : state === "current"
                      ? "bg-brand-subtle text-brand border border-brand"
                      : "bg-bg-surface text-fg-subtle border border-border"
                }`}
              >
                {state === "done" ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>
                ) : (
                  String(i + 1).padStart(2, "0")
                )}
              </div>
              <span
                className={`text-[12px] font-medium uppercase tracking-wider truncate ${
                  state === "current"
                    ? "text-fg"
                    : state === "done"
                      ? "text-fg-muted"
                      : "text-fg-subtle"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-px ${
                  i < currentIdx ? "bg-brand/40" : "bg-border"
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PickStep(props: {
  agents: AgentOption[];
  envs: EnvironmentOption[];
  agentId: string;
  setAgentId: (v: string) => void;
  envId: string;
  setEnvId: (v: string) => void;
  personaName: string;
  setPersonaName: (v: string) => void;
  personaAvatar: string;
  setPersonaAvatar: (v: string) => void;
  working: boolean;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-2 gap-4">
        <Field label="Agent">
          <Combobox<{ id: string; name: string; created_at?: string }>
            value={props.agentId}
            onValueChange={(v) => props.setAgentId(v)}
            endpoint="/v1/agents"
            getValue={(a) => a.id}
            getLabel={(a) => (
              <span className="flex items-center justify-between gap-2 w-full min-w-0">
                <span className="truncate">{a.name}</span>
                {a.created_at && (
                  <span className="text-xs text-fg-subtle shrink-0">
                    {formatRelative(Date.now() - new Date(a.created_at).getTime())}
                  </span>
                )}
              </span>
            )}
            getTextLabel={(a) => a.name}
            placeholder="Pick an agent…"
          />
        </Field>

        <Field label="Environment">
          <Combobox<{ id: string; name: string; created_at?: string }>
            value={props.envId}
            onValueChange={(v) => props.setEnvId(v)}
            endpoint="/v1/environments"
            getValue={(e) => e.id}
            getLabel={(e) => (
              <span className="flex items-center justify-between gap-2 w-full min-w-0">
                <span className="truncate">{e.name}</span>
                {e.created_at && (
                  <span className="text-xs text-fg-subtle shrink-0">
                    {formatRelative(Date.now() - new Date(e.created_at).getTime())}
                  </span>
                )}
              </span>
            )}
            getTextLabel={(e) => e.name}
            placeholder="Pick an environment…"
          />
        </Field>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Field label="Persona name (shown in Slack)">
          <TextInput
            value={props.personaName}
            onChange={(e) => props.setPersonaName(e.target.value)}
            placeholder="e.g. Coder, Designer, Triage"
            className={inputCls}
          />
        </Field>

        <Field label="Avatar URL (optional)">
          <TextInput
            value={props.personaAvatar}
            onChange={(e) => props.setPersonaAvatar(e.target.value)}
            placeholder="https://…"
            className={inputCls}
          />
        </Field>
      </div>

      <div className="rounded-md border border-border bg-bg-surface/30 px-3.5 py-3 text-[12px] text-fg-muted">
        Your agent becomes a real Slack teammate — @-mentionable, replies in threads,
        joins DMs. Setup ~3 min, requires Slack admin.
      </div>

      <div className="pt-1">
        <button
          onClick={props.onContinue}
          disabled={props.working}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          {props.working ? "Working…" : "Continue"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </div>
    </div>
  );
}

function A1CredentialsStep(props: {
  form: A1FormStep;
  agentName: string;
  envName: string;
  personaName: string;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  signingSecret: string;
  setSigningSecret: (v: string) => void;
  working: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const manifestUrl = props.form.manifestLaunchUrl;
  return (
    <div className="space-y-7">
      {/* Breadcrumb — current agent / env / persona, with Change link back to pick step. */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-surface/30 px-3.5 py-2 text-[12px]">
        <div className="text-fg-muted truncate">
          Publishing{" "}
          <span className="text-fg font-medium">{props.personaName || props.agentName}</span>
          {" "}({props.agentName}) →{" "}
          <span className="text-fg font-medium">{props.envName}</span>
        </div>
        <button
          type="button"
          onClick={props.onBack}
          disabled={props.working}
          className="text-brand hover:underline disabled:opacity-50 shrink-0"
        >
          Change ←
        </button>
      </div>
      {manifestUrl && (
        <section className="rounded-md border border-brand/30 bg-brand-subtle/30 p-4">
          <h2 className="text-[15px] font-medium text-fg mb-1">
            One-click setup
          </h2>
          <p className="text-[13px] text-fg-muted mb-3">
            Let Slack pre-configure the App for you — name, scopes, events, and
            redirect URLs come from a manifest we ship. You'll just confirm in
            Slack, then come back here to paste 3 secrets.
          </p>
          <a
            href={manifestUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Create Slack App
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M7 7h10v10" /></svg>
          </a>
          <p className="text-[12px] text-fg-subtle mt-2">
            Opens api.slack.com in a new tab. After Slack creates the App, copy
            <strong> Client ID</strong>, <strong>Client Secret</strong>, and
            <strong> Signing Secret</strong> from the App's <em>Basic Information</em>
            page and paste them below.
          </p>
        </section>
      )}

      <details className="rounded-md border border-border bg-bg-surface/30 px-3.5 py-2" open={!manifestUrl}>
        <summary className="text-[13px] font-medium text-fg cursor-pointer py-1.5">
          {manifestUrl ? "Or set up the App manually" : "Create a Slack App manually"}
        </summary>
        <div className="pt-3 pb-1.5">
          <p className="text-[13px] text-fg-muted mb-3">
            Open{" "}
            <a
              href="https://api.slack.com/apps"
              target="_blank"
              rel="noreferrer"
              className="text-brand hover:underline"
            >
              api.slack.com → Your Apps
            </a>{" "}
            → Create New App → From scratch. Name it and pick your workspace.
            Then plug these URLs into the App settings:
          </p>
          <div className="rounded-md border border-border bg-bg-surface/30 divide-y divide-border">
            <CopyRow label="App name" value={props.form.suggestedAppName} />
            <CopyRow label="Redirect URL" value={props.form.callbackUrl} />
            <CopyRow label="Events Request URL" value={props.form.webhookUrl} />
          </div>
          <p className="text-[12px] text-fg-subtle mt-2">
            Paste the Redirect URL under <strong>OAuth &amp; Permissions</strong>; the
            Events Request URL above ends in <code>/__pending__</code> as a placeholder —
            after install completes, the success screen surfaces the real URL keyed on
            your Slack app id; paste that into <strong>Event Subscriptions</strong>{" "}
            and wait for the green "Verified" check.
            Subscribe to bot events: <code>app_mention</code>,{" "}
            <code>message.channels</code>, <code>message.im</code>,{" "}
            <code>message.groups</code>, <code>message.mpim</code>,{" "}
            <code>tokens_revoked</code>, <code>app_uninstalled</code>.
          </p>
          <p className="text-[12px] text-fg-subtle mt-2">
            <strong>Required for MCP tools:</strong> open the App's{" "}
            <strong>Agents &amp; AI Apps</strong> (or <em>app-assistant</em>) page and
            enable <strong>Slack MCP server access</strong>. Without this, the
            agent falls back to bash + curl on every Slack action because{" "}
            <code>mcp.slack.com</code> rejects the token with{" "}
            <code>"App is not enabled for Slack MCP server access"</code>.
          </p>
        </div>
      </details>

      <section>
        <h2 className="text-[15px] font-medium text-fg mb-1.5">
          Paste credentials Slack gave you
        </h2>
        <p className="text-[13px] text-fg-muted mb-3">
          From your Slack App's <strong>Basic Information</strong> page. The Signing
          Secret signs all incoming webhooks; we verify every event with it.
        </p>
        <div className="mb-3">
          <a
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md border border-border text-fg-muted hover:text-fg hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Open Slack App settings ↗
          </a>
          <p className="text-[12px] text-fg-subtle mt-1.5">
            Click <strong>Show</strong> next to <strong>Client Secret</strong> /
            <strong> Signing Secret</strong> on Slack's page to reveal them.
            Both are 32-char hex strings (look like <code>c83b3cf17e1dee5cdc5f55fdcb6a2f23</code>) —
            <strong> not</strong> the Client ID (<code>5720…</code>) or the
            Verification Token. Copy each value precisely.
          </p>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Client ID">
            <TextInput
              value={props.clientId}
              onChange={(e) => props.setClientId(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Client Secret">
            <SecretInput
              value={props.clientSecret}
              onChange={(e) => props.setClientSecret(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Signing Secret">
            <SecretInput
              value={props.signingSecret}
              onChange={(e) => props.setSigningSecret(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button
            onClick={props.onBack}
            disabled={props.working}
            className="text-[13px] text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] disabled:opacity-50"
          >
            ← Back
          </button>
          <button
            onClick={props.onSubmit}
            disabled={props.working || !props.clientId || !props.clientSecret || !props.signingSecret}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            {props.working ? "Validating…" : "Continue"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </section>
    </div>
  );
}

function A1InstallStep({ link, onBack }: { link: A1InstallLink; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-medium text-fg mb-1.5">
          Install the app in your workspace
        </h2>
        <p className="text-[13px] text-fg-muted">
          We've validated your credentials. Click below to authorize the install in
          Slack — you'll be redirected back here automatically.
        </p>
      </div>

      {/* The pre-install MCP-toggle warning lived here for ~weeks because
          Slack docs claimed `is_mcp_enabled` wasn't a manifest field. Per
          the current manifest reference it IS — manifest.ts:96 sets it
          true at app creation, so MCP is on out of the box. The post-
          install probe banner (lines 156-179) is the safety net for users
          who flip it back off manually. */}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="text-[13px] text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          ← Back
        </button>
        <a
          href={link.url}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          Install in Slack
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M7 7h10v10" /></svg>
        </a>
      </div>

      <details className="text-[12px] text-fg-muted mt-3">
        <summary className="cursor-pointer hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">
          Verify the URLs Slack should now show
        </summary>
        <div className="mt-2 rounded-md border border-border bg-bg-surface/30 divide-y divide-border">
          <CopyRow label="Redirect URL" value={link.callbackUrl} />
          <CopyRow label="Events Request URL" value={link.webhookUrl} />
        </div>
      </details>
    </div>
  );
}

function CopyRow({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(!secret);
  function copy() {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  const display = secret && !reveal ? "•".repeat(Math.min(value.length, 28)) : value;
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="text-[11px] text-fg-muted font-mono uppercase tracking-wider w-28 shrink-0">
        {label}
      </span>
      <code className="flex-1 text-[12px] font-mono text-fg truncate select-all">
        {display}
      </code>
      <div className="flex items-center gap-1 shrink-0">
        {secret && (
          <button
            onClick={() => setReveal((r) => !r)}
            className="text-[11px] text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] px-1.5 py-0.5 rounded"
            title={reveal ? "Hide" : "Reveal"}
          >
            {reveal ? "Hide" : "Show"}
          </button>
        )}
        <button
          onClick={copy}
          className={`text-[11px] px-2 py-0.5 rounded transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
            copied
              ? "text-success bg-success-subtle"
              : "text-fg-muted hover:text-fg hover:bg-bg-surface"
          }`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

const selectCls = inputCls;
