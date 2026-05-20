import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type {
  LinearPublicationShell,
  LinearPublicationInstallLink,
} from "../api/types";
import { SecretInput, TextInput } from "../../components/Input";
import { Combobox } from "../../components/Combobox";
import { Field } from "../../components/Field";

const api = new IntegrationsApi();

interface AgentOption {
  id: string;
  name: string;
}

interface EnvironmentOption {
  id: string;
  name: string;
}

interface PublishWizardProps {
  loadAgents: () => Promise<AgentOption[]>;
  loadEnvironments: () => Promise<EnvironmentOption[]>;
}

type Step = "pick" | "credentials" | "install";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "pick", label: "Configure" },
  { id: "credentials", label: "Credentials" },
  { id: "install", label: "Install" },
];

/**
 * Publication-first wizard. Three discrete steps, each touching exactly
 * one anchor row server-side:
 *
 *   1. POST  /v1/integrations/linear/publications      → creates pending pub
 *   2. PATCH /v1/integrations/linear/publications/:id/credentials
 *                                                       → fills + advances
 *   3. <a href={install_url}>                           → OAuth callback
 *                                                         binds installation
 *
 * If the user closes the tab mid-flow, the pub stays in pending_setup /
 * awaiting_install and the wizard can resume from `?publication_id=...`
 * (re-using the same callback URL they already pasted into Linear).
 */
export function IntegrationsLinearPublishWizard({
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
  // True while we hydrate from `?pub=`; suppresses the empty pick step.
  const [hydrating, setHydrating] = useState<boolean>(Boolean(resumePubId));

  const [shell, setShell] = useState<LinearPublicationShell | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [installLink, setInstallLink] = useState<LinearPublicationInstallLink | null>(null);

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

  // Refresh-resume hydration. When the wizard renders with `?pub=<id>` set
  // by replaceState below or the pending-pub list page, re-derive the shell
  // payload and pre-fill the form. Linear keys directly off the publicationId
  // (no formToken JWT), so this is just a re-fetch of the existing row plus
  // a re-build of the callback/webhook URLs.
  useEffect(() => {
    if (!resumePubId) return;
    let cancelled = false;
    void (async () => {
      try {
        const pub = await api.linear.getPublication(resumePubId);
        if (cancelled) return;
        if (pub.status === "live") {
          window.location.href = "/integrations/linear";
          return;
        }
        if (pub.status === "unpublished" || pub.status === "needs_reauth") {
          search.delete("pub");
          setSearch(search, { replace: true });
          setHydrating(false);
          return;
        }
        const re = await api.linear.reissueFormToken(resumePubId);
        if (cancelled) return;
        setShell(re);
        setAgentId(pub.agent_id);
        setEnvId(pub.environment_id);
        setPersonaName(pub.persona.name);
        if (pub.persona.avatarUrl) setPersonaAvatar(pub.persona.avatarUrl);
        // Always render the credentials step on resume so the user can
        // re-paste; the install link is re-issued by submitCredentials.
        setStep("credentials");
      } catch (err) {
        if (!cancelled) {
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
    // Resume runs once per wizard mount.
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

  const returnUrl = `${window.location.origin}/integrations/linear`;

  /** Stamp ?pub=<id> into the URL so a refresh resumes the wizard. */
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
      const s = await api.linear.createPublication({
        agentId,
        environmentId: envId,
        personaName,
        personaAvatarUrl: personaAvatar || null,
        returnUrl,
      });
      setShell(s);
      setStep("credentials");
      pinPublicationToUrl(s.publication_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function submitCredentials() {
    if (!shell || !clientId || !clientSecret || !webhookSecret) return;
    setError(null);
    setWorking(true);
    try {
      const link = await api.linear.submitCredentialsForPublication(
        shell.publication_id,
        {
          clientId,
          clientSecret,
          webhookSecret,
          returnUrl,
        },
      );
      setInstallLink(link);
      setStep("install");
      pinPublicationToUrl(link.publication_id);
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
          to="/integrations/linear"
          className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          ← Linear integrations
        </Link>

        <header className="mt-3 mb-6">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
            Publish agent to Linear
          </h1>
          <p className="mt-1.5 text-[14px] text-fg-muted">
            Make this agent a teammate in your Linear workspace.
          </p>
        </header>

        <StepIndicator current={step} />

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

        {!hydrating && step === "credentials" && shell && (
          <CredentialsStep
            shell={shell}
            clientId={clientId}
            setClientId={setClientId}
            clientSecret={clientSecret}
            setClientSecret={setClientSecret}
            webhookSecret={webhookSecret}
            setWebhookSecret={setWebhookSecret}
            working={working}
            onSubmit={submitCredentials}
          />
        )}

        {!hydrating && step === "install" && installLink && <InstallStep link={installLink} />}
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
          <Combobox<{ id: string; name: string }>
            value={props.agentId}
            onValueChange={(v) => props.setAgentId(v)}
            endpoint="/v1/agents"
            getValue={(a) => a.id}
            getLabel={(a) => a.name}
            getTextLabel={(a) => a.name}
            placeholder="Pick an agent…"
          />
        </Field>

        <Field label="Environment">
          <Combobox<{ id: string; name: string }>
            value={props.envId}
            onValueChange={(v) => props.setEnvId(v)}
            endpoint="/v1/environments"
            getValue={(e) => e.id}
            getLabel={(e) => e.name}
            getTextLabel={(e) => e.name}
            placeholder="Pick an environment…"
          />
        </Field>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Field label="Persona name (shown in Linear)">
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
        Your agent becomes a real Linear teammate with @autocomplete and a slot in the
        assignee dropdown. Setup ~3 min, requires Linear admin (or send a setup link).
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

function CredentialsStep(props: {
  shell: LinearPublicationShell;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  webhookSecret: string;
  setWebhookSecret: (v: string) => void;
  working: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-7">
      <section>
        <h2 className="text-[15px] font-medium text-fg mb-1.5">
          Create a Linear OAuth app
        </h2>
        <p className="text-[13px] text-fg-muted mb-3">
          Open{" "}
          <a
            href="https://linear.app/settings/api/applications/new"
            target="_blank"
            rel="noreferrer"
            className="text-brand hover:underline"
          >
            Linear → Settings → API → New application
          </a>{" "}
          and register a new OAuth application with these values:
        </p>
        <div className="rounded-md border border-border bg-bg-surface/30 divide-y divide-border">
          <CopyRow label="Application name" value={props.shell.suggested_app_name} />
          <CopyRow label="Developer name" value={props.shell.suggested_app_name} />
          <CopyRow label="Developer URL" value={window.location.origin} />
          <CopyRow
            label="Description"
            value={`OMA-managed agent — ${props.shell.suggested_app_name}.`}
          />
          <CopyRow label="Callback URLs" value={props.shell.callback_url} />
          <CopyRow label="Webhook URL" value={props.shell.webhook_url} />
        </div>
        <ul className="text-[12px] text-fg-muted mt-3 space-y-1.5 list-disc pl-5">
          <li>
            <strong className="text-fg">GitHub username</strong> — leave empty.
            Only relevant if you also bind this OAuth app to a GitHub App with
            <code className="mx-0.5">actor=app</code>; not used by OMA's
            Linear-only flow.
          </li>
          <li>
            <strong className="text-fg">Public</strong> — leave OFF. Public is
            for app marketplace listings; this app is private to your workspace.
          </li>
          <li>
            <strong className="text-fg">Client credentials</strong> — leave OFF.
            OMA uses the standard authorization-code OAuth flow.
          </li>
          <li>
            <strong className="text-fg">Webhooks</strong> — toggle ON, paste the
            Webhook URL above, and subscribe to{" "}
            <code>App user notifications</code> +{" "}
            <code>Agent session events</code>. Linear shows the signing secret
            (<code>lin_wh_…</code>) once you save — copy it back below.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-[15px] font-medium text-fg mb-1.5">
          Paste credentials Linear gave you
        </h2>
        <p className="text-[13px] text-fg-muted mb-3">
          From the OAuth app you just created. The webhook signing secret is on
          the same page (Webhooks → Signing secret).
        </p>
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
          <Field label="Webhook signing secret (lin_wh_…)">
            <SecretInput
              value={props.webhookSecret}
              onChange={(e) => props.setWebhookSecret(e.target.value)}
              placeholder="lin_wh_…"
              className={inputCls}
            />
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button
            onClick={props.onSubmit}
            disabled={props.working || !props.clientId || !props.clientSecret || !props.webhookSecret}
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

function InstallStep({ link }: { link: LinearPublicationInstallLink }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-medium text-fg mb-1.5">
          Install the app in your workspace
        </h2>
        <p className="text-[13px] text-fg-muted">
          We've stored your credentials. Click below to authorize the install in
          Linear — you'll be redirected back here automatically.
        </p>
      </div>

      <a
        href={link.install_url}
        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
      >
        Install in Linear
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M7 7h10v10" /></svg>
      </a>

      <details className="text-[12px] text-fg-muted mt-3">
        <summary className="cursor-pointer hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">
          Verify the URLs Linear should now show
        </summary>
        <div className="mt-2 rounded-md border border-border bg-bg-surface/30 divide-y divide-border">
          <CopyRow label="Callback URL" value={link.callback_url} />
          <CopyRow label="Webhook URL" value={link.webhook_url} />
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
