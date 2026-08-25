import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type {
  A1FormStep,
  A1InstallLink,
  FeishuSessionGranularity,
  FeishuTenantType,
} from "../api/types";
import { SecretInput, TextInput } from "../../components/Input";
import { Combobox } from "../../components/Combobox";
import { Field } from "../../components/Field";

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

// Feishu has no OAuth and no external install URL — credentials are the
// install. Two steps: pick agent/env/persona, then paste the four App
// secrets from the Feishu developer console. submitCredentials drives the
// server straight to `live` (status elides `credentials_filled`).
type Step = "pick" | "credentials" | "complete";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "pick", label: "Configure" },
  { id: "credentials", label: "Credentials" },
  { id: "complete", label: "Active" },
];

const TENANT_TYPES: Array<{ value: FeishuTenantType; label: string; hint: string }> = [
  {
    value: "internal",
    label: "Internal tenant",
    hint: "For bots that will live inside one organization. Most self-hosted installs.",
  },
  {
    value: "external",
    label: "External (ISV) tenant",
    hint: "For apps distributed across many tenants via the Feishu App Store.",
  },
];

const GRANULARITY_OPTIONS: Array<{
  value: FeishuSessionGranularity;
  label: string;
  hint: string;
}> = [
  {
    value: "per_chat",
    label: "Per chat",
    hint: "One session per chat; full history in context.",
  },
  {
    value: "per_chat_user",
    label: "Per chat × user",
    hint: "Isolated context per (chat, sender).",
  },
];

export function IntegrationsFeishuPublishWizard({
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
  const [tenantType, setTenantType] = useState<FeishuTenantType>("internal");
  const [granularity, setGranularity] = useState<FeishuSessionGranularity>("per_chat");

  const [step, setStep] = useState<Step>("pick");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while we hydrate from `?pub=` so we don't render the (empty) "pick"
  // step while we're still resolving the existing publication's state.
  const [hydrating, setHydrating] = useState<boolean>(Boolean(resumePubId));

  const [a1Form, setA1Form] = useState<A1FormStep | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [encryptKey, setEncryptKey] = useState("");
  // No "install link" step in Feishu — but we keep `A1InstallLink` typed so
  // the surface mirrors Slack. After submitCredentials we either show the
  // install-result link (callback/webhook URLs to paste into Feishu) or
  // jump straight to `complete`.
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
        const pub = await api.feishu.getPublication(resumePubId);
        if (cancelled) return;
        // Already-live pubs belong on the list page, not the wizard.
        if (pub.status === "live") {
          window.location.href = "/integrations/feishu";
          return;
        }
        if (pub.status === "unpublished" || pub.status === "needs_reauth") {
          // Drop the bad ?pub= so the wizard re-renders fresh.
          search.delete("pub");
          setSearch(search, { replace: true });
          setHydrating(false);
          return;
        }
        // Re-issue a fresh formToken for the existing shell.
        const form = await api.feishu.reissueFormToken(resumePubId);
        if (cancelled) return;
        setA1Form(form);
        setAgentId(pub.agent_id);
        setEnvId(pub.environment_id);
        setPersonaName(pub.persona.name);
        if (pub.persona.avatarUrl) setPersonaAvatar(pub.persona.avatarUrl);
        // Feishu's adapter goes pending_setup → live in one submit, so
        // either state lands on the credentials step.
        setStep("credentials");
      } catch (err) {
        if (!cancelled) {
          // Resume failed (e.g. 404 / 409). Drop the bad ?pub= so the
          // wizard falls back to the fresh-pick path.
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

  const returnUrl = `${window.location.origin}/integrations/feishu`;

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
      const f = await api.feishu.startA1({
        agentId,
        environmentId: envId,
        personaName,
        personaAvatarUrl: personaAvatar || null,
        returnUrl,
      });
      setA1Form(f);
      setStep("credentials");
      if (f.publicationId) pinPublicationToUrl(f.publicationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function submitCredentials() {
    if (
      !a1Form ||
      !appId ||
      !appSecret
    )
      return;
    setError(null);
    setWorking(true);
    try {
      const link = await api.feishu.submitCredentials({
        formToken: a1Form.formToken,
        appId,
        appSecret,
        verificationToken,
        encryptKey,
        tenantType,
        sessionGranularity: granularity,
      });
      setA1InstallLink(link);
      setStep("complete");
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
          to="/integrations/feishu"
          className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          ← Feishu integrations
        </Link>

        <header className="mt-3 mb-6">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
            Publish agent to Feishu
          </h1>
          <p className="mt-1.5 text-[14px] text-fg-muted">
            Connect an agent to a Feishu tenant — it joins chats, replies to messages,
            reacts, all from a single App.
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
            tenantType={tenantType}
            setTenantType={setTenantType}
            granularity={granularity}
            setGranularity={setGranularity}
            working={working}
            onContinue={startPublish}
          />
        )}

        {!hydrating && step === "credentials" && a1Form && (
          <CredentialsStep
            form={a1Form}
            agentName={agents.find((a) => a.id === agentId)?.name ?? agentId}
            envName={envs.find((e) => e.id === envId)?.name ?? envId}
            personaName={personaName}
            appId={appId}
            setAppId={setAppId}
            appSecret={appSecret}
            setAppSecret={setAppSecret}
            verificationToken={verificationToken}
            setVerificationToken={setVerificationToken}
            encryptKey={encryptKey}
            setEncryptKey={setEncryptKey}
            working={working}
            onSubmit={submitCredentials}
            onBack={() => setStep("pick")}
          />
        )}

        {!hydrating && step === "complete" && (
          <CompleteStep
            link={a1InstallLink}
            publicationId={search.get("pub")}
            onDone={() => {
              window.location.href = "/integrations/feishu";
            }}
          />
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
  tenantType: FeishuTenantType;
  setTenantType: (v: FeishuTenantType) => void;
  granularity: FeishuSessionGranularity;
  setGranularity: (v: FeishuSessionGranularity) => void;
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
            getLabel={(a) => <span className="truncate">{a.name}</span>}
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
            getLabel={(e) => <span className="truncate">{e.name}</span>}
            getTextLabel={(e) => e.name}
            placeholder="Pick an environment…"
          />
        </Field>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Field label="Persona name (shown in Feishu)">
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

      <div>
        <label className="text-[13px] font-medium text-fg mb-2 block">
          Tenant type
        </label>
        <div className="space-y-2">
          {TENANT_TYPES.map((t) => (
            <label
              key={t.value}
              className="flex items-start gap-2 cursor-pointer hover:text-fg text-fg-muted"
            >
              <input
                type="radio"
                name="tenant-type"
                value={t.value}
                checked={props.tenantType === t.value}
                onChange={() => props.setTenantType(t.value)}
                className="accent-brand mt-0.5"
              />
              <span>
                <span className="text-[13px] font-medium text-fg">{t.label}</span>
                <span className="block text-[12px] text-fg-muted leading-relaxed">
                  {t.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[13px] font-medium text-fg mb-2 block">
          Session granularity
        </label>
        <div className="space-y-2">
          {GRANULARITY_OPTIONS.map((g) => (
            <label
              key={g.value}
              className="flex items-start gap-2 cursor-pointer hover:text-fg text-fg-muted"
            >
              <input
                type="radio"
                name="granularity"
                value={g.value}
                checked={props.granularity === g.value}
                onChange={() => props.setGranularity(g.value)}
                className="accent-brand mt-0.5"
              />
              <span>
                <span className="text-[13px] font-medium text-fg">{g.label}</span>
                <span className="block text-[12px] text-fg-muted leading-relaxed">
                  {g.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-border bg-bg-surface/30 px-3.5 py-3 text-[12px] text-fg-muted">
        No OAuth dance — Feishu uses App ID + App Secret (required), plus two
        optional signing keys, pasted in the next step. Setup ~3 min, requires
        Feishu admin access to the App console.
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
  form: A1FormStep;
  agentName: string;
  envName: string;
  personaName: string;
  appId: string;
  setAppId: (v: string) => void;
  appSecret: string;
  setAppSecret: (v: string) => void;
  verificationToken: string;
  setVerificationToken: (v: string) => void;
  encryptKey: string;
  setEncryptKey: (v: string) => void;
  working: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
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

      <section>
        <h2 className="text-[15px] font-medium text-fg mb-1.5">
          Create a Feishu App
        </h2>
        <p className="text-[13px] text-fg-muted mb-3">
          Open the{" "}
          <a
            href="https://openplatform.feishu.cn/app"
            target="_blank"
            rel="noreferrer"
            className="text-brand hover:underline"
          >
            Feishu Open Platform → App console
          </a>{" "}
          and create a Custom App. Then plug these URLs into the App's
          <strong> Event Subscriptions</strong> page:
        </p>
        <div className="rounded-md border border-border bg-bg-surface/30 divide-y divide-border">
          <CopyRow label="App name" value={props.form.suggestedAppName} />
          <CopyRow label="Event URL" value={props.form.webhookUrl} />
          <CopyRow label="Verification token (we'll verify against yours)" value={props.form.callbackUrl} />
        </div>
        <p className="text-[12px] text-fg-subtle mt-2">
          Add <code>im.message.receive_v1</code> as a subscribed event, grant
          the bot <code>im:message</code> / <code>im:chat</code> /
          <code>im:reaction</code> scopes (matches our capability toggles), and
          publish the App version so events flow.
        </p>
      </section>

      <section>
        <h2 className="text-[15px] font-medium text-fg mb-1.5">
          Paste credentials Feishu gave you
        </h2>
        <p className="text-[13px] text-fg-muted mb-3">
          From the App's <strong>Credentials &amp; Basic Info</strong> page
          (<strong>App ID</strong>, <strong>App Secret</strong>,
          <strong> Verification Token</strong>) and{" "}
          <strong>Event Subscriptions → Encrypt Key</strong>.{" "}
          <strong>App ID</strong> and <strong>App Secret</strong> are required;
          the <strong>Verification Token</strong> and <strong>Encrypt Key</strong>{" "}
          are optional — they're only used for the HTTP webhook ingest path, not
          the long-connection (WebSocket) mode this App uses. All provided values
          are encrypted at rest with the platform root secret.
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="App ID">
            <TextInput
              value={props.appId}
              onChange={(e) => props.setAppId(e.target.value)}
              placeholder="cli_…"
              className={inputCls}
            />
          </Field>
          <Field label="App Secret">
            <SecretInput
              value={props.appSecret}
              onChange={(e) => props.setAppSecret(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Verification Token (optional)">
            <SecretInput
              value={props.verificationToken}
              onChange={(e) => props.setVerificationToken(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Encrypt Key (optional)">
            <SecretInput
              value={props.encryptKey}
              onChange={(e) => props.setEncryptKey(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        <p className="text-[12px] text-fg-subtle mt-2">
          Verification Token &amp; Encrypt Key are optional — leave them blank
          for long-connection (WebSocket) Apps. Provide them only if your App
          uses the HTTP event-callback ingest path.
        </p>

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
            disabled={
              props.working ||
              !props.appId ||
              !props.appSecret
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            {props.working ? "Activating…" : "Activate"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </section>
    </div>
  );
}

function CompleteStep({
  link,
  publicationId,
  onDone,
}: {
  link: A1InstallLink | null;
  publicationId: string | null;
  onDone: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="rounded-md border border-success/30 bg-success-subtle px-4 py-3.5 text-[13px]">
        <div className="font-medium text-success mb-1">
          ✓ Feishu credentials accepted
        </div>
        <p className="text-fg-muted text-[12px] leading-relaxed">
          Your agent is <code>live</code>. Feishu will deliver events from any
          chat the bot has been added to; the platform mints a tenant access
          token on demand and — when you provided one — decrypts inbound HTTP
          events with the Encrypt Key.
        </p>
        {publicationId && (
          <p className="text-fg-muted text-[12px] mt-2">
            Publication: <code className="text-fg">{publicationId}</code>
          </p>
        )}
      </div>

      {link && (
        <div className="rounded-md border border-border bg-bg-surface/30 px-3.5 py-3 text-[12px] text-fg-muted">
          <p className="mb-2">
            These URLs should already be configured in your Feishu App —
            confirm them as a sanity check:
          </p>
          <div className="rounded-md border border-border bg-bg divide-y divide-border">
            <CopyRow label="Callback URL" value={link.callbackUrl} />
            <CopyRow label="Event URL" value={link.webhookUrl} />
          </div>
        </div>
      )}

      <div className="pt-1">
        <button
          onClick={onDone}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          Back to Feishu integrations
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </div>
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
