import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PopoverContent } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { DataTable, type ColumnDef } from "../components/DataTable";
import { Field } from "../components/Field";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { Page } from "../components/Page";
import type { RowAction } from "../components/RowContextMenu";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n/types";
import {
  matter,
  MatterError,
  type Bond,
  type BondResource,
  type FieldSchema,
  type Loop,
  type LoopTemplate,
  type MatterIssue,
} from "../lib/matter";
import { useManagedApi } from "../lib/useManagedApi";
import {
  loopPath,
  MatterNotice,
  MatterSection,
  MatterTitle,
  ProviderIcon,
  SetupResult,
  StatusPill,
  useMatterError,
  type Provider,
} from "./matter/shared";

/**
 * Loops. A Loop is a template plus its configuration: which linked app it
 * runs on (the Bond), which Agent answers, and the template's own options.
 * `/loops` shows your Loops above the templates to start from; a Loop is
 * created and edited on its own settings page.
 */

type Agent = { id: string; name: string };
/** An environment or vault, as the session settings list it. */
type Choice = { id: string; name: string };

/** A Memory Store a Loop mounts in its sessions, as its config saves it. */
type MemoryStoreChoice = { id: string; access: "read_write" | "read_only" };

/** The Environment option that keeps the service's default. */
const DEFAULT_ENVIRONMENT = "__default";

function useLoopData() {
  const errorText = useMatterError();
  const managedApi = useManagedApi();
  const [templates, setTemplates] = useState<LoopTemplate[]>([]);
  const [loops, setLoops] = useState<Loop[]>([]);
  const [bonds, setBonds] = useState<Bond[]>([]);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [environments, setEnvironments] = useState<Choice[] | null>(null);
  const [vaults, setVaults] = useState<Choice[] | null>(null);
  const [memoryStores, setMemoryStores] = useState<Choice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [tp, lp, bd] = await Promise.all([
        matter<{ data: LoopTemplate[] }>("/loop-templates"),
        matter<{ data: Loop[] }>("/loops"),
        matter<{ data: Bond[] }>("/bonds"),
      ]);
      setTemplates(tp.data);
      setLoops(lp.data);
      setBonds(bd.data);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
    // errorText only reads the current locale's messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadBonds = useCallback(async () => {
    setBonds((await matter<{ data: Bond[] }>("/bonds")).data);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let live = true;
    managedApi.agents
      .list({ limit: 200 })
      .then((r) => live && setAgents(r.data.map((a) => ({ id: a.id, name: a.name || a.id }))))
      .catch(() => live && setAgents([]));
    managedApi.environments
      .list({ limit: 200 })
      .then((r) => live && setEnvironments(r.data.map((e) => ({ id: e.id, name: e.name || e.id }))))
      .catch(() => live && setEnvironments([]));
    managedApi.vaults
      .list({ limit: 200 })
      .then((r) => live && setVaults(r.data.map((v) => ({ id: v.id, name: v.display_name || v.id }))))
      .catch(() => live && setVaults([]));
    managedApi.memoryStores
      .list({ limit: 200 })
      .then(
        (r) =>
          live &&
          setMemoryStores(r.data.filter((s) => !s.archived_at).map((s) => ({ id: s.id, name: s.name || s.id }))),
      )
      .catch(() => live && setMemoryStores([]));
    return () => {
      live = false;
    };
  }, [managedApi]);

  return { templates, loops, bonds, agents, environments, vaults, memoryStores, loading, error, reload, reloadBonds };
}

type LoopState = "running" | "starting" | "error" | "disabled";

const loopState = (loop: Loop): LoopState =>
  !loop.enabled ? "disabled" : loop.state.lastError ? "error" : loop.state.running ? "running" : "starting";

function LoopStatus({ loop }: { loop: Loop }) {
  const { t } = useI18n();
  const m = t.matter;
  if (!loop.enabled) return <StatusPill tone="muted">{m.disabled}</StatusPill>;
  if (loop.state.lastError)
    return (
      <span title={`${m.lastError}: ${loop.state.lastError.message}`}>
        <StatusPill tone="danger">{m.error}</StatusPill>
      </span>
    );
  return loop.state.running ? (
    <StatusPill tone="success">{m.running}</StatusPill>
  ) : (
    <StatusPill tone="warning">{m.starting}</StatusPill>
  );
}

const PROVIDERS: Provider[] = ["feishu", "gitlab"];

/** `/loops`: your Loops, in the list every other page uses. */
export function LoopsPage() {
  const { t } = useI18n();
  const m = t.matter;
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { templates, loops, bonds, agents, loading, error, reload } = useLoopData();
  const [search, setSearch] = useState("");
  const [app, setApp] = useState<Provider | "any">("any");
  const [status, setStatus] = useState<LoopState | "any">("any");

  const templateName = (id: string) => m.templates[id]?.name ?? templates.find((tp) => tp.id === id)?.name ?? id;
  const agentName = (id: unknown) => agents?.find((a) => a.id === id)?.name ?? (typeof id === "string" ? id : "");
  const bondLabel = (id: string) => bonds.find((b) => b.id === id)?.label ?? id.slice(id.indexOf(":") + 1);
  const providerOf = (loop: Loop) => loop.provider ?? templates.find((tp) => tp.id === loop.template)?.provider ?? "feishu";

  const columns = useMemo<ColumnDef<Loop>[]>(
    () => [
      {
        id: "template",
        header: m.loops.template,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2 font-medium text-fg">
            <ProviderIcon provider={providerOf(row.original)} className="size-4 shrink-0" />
            {templateName(row.original.template)}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "bond",
        header: m.loops.bond,
        cell: ({ row }) => <span className="text-fg-muted">{bondLabel(row.original.config.bond)}</span>,
      },
      {
        id: "agent",
        header: m.loops.agent,
        cell: ({ row }) => <span className="text-fg-muted">{agentName(row.original.config.agentId)}</span>,
      },
      {
        id: "status",
        header: t.common.status,
        cell: ({ row }) => <LoopStatus loop={row.original} />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, templates, bonds, agents],
  );

  // Old Feishu links land on `/loops?template=feishu-agent`.
  const legacy = params.get("template");
  if (legacy) return <Navigate to={`/loops/new?template=${encodeURIComponent(legacy)}`} replace />;

  async function setEnabled(loop: Loop, enabled: boolean) {
    await matter(loopPath(loop.id), { method: "PATCH", body: JSON.stringify({ enabled }) }).catch(() => undefined);
    await reload();
  }

  async function remove(loop: Loop) {
    if (!window.confirm(m.loops.confirmDelete)) return;
    await matter(loopPath(loop.id), { method: "DELETE" }).catch(() => undefined);
    await reload();
  }

  const rowActions = (loop: Loop): RowAction[] => [
    { label: t.common.edit, onSelect: () => nav(loopPath(loop.id)) },
    loop.enabled
      ? { label: m.disable, onSelect: () => void setEnabled(loop, false) }
      : { label: m.enable, onSelect: () => void setEnabled(loop, true) },
    { label: t.common.delete, onSelect: () => void remove(loop), destructive: true },
  ];

  const q = search.trim().toLowerCase();
  const shown = loops.filter(
    (l) =>
      (app === "any" || providerOf(l) === app) &&
      (status === "any" || loopState(l) === status) &&
      (q === "" ||
        `${templateName(l.template)} ${bondLabel(l.config.bond)} ${agentName(l.config.agentId)}`.toLowerCase().includes(q)),
  );
  const filtering = q !== "" || app !== "any" || status !== "any";

  const appOptions = [{ value: "any", label: m.loops.all }, ...PROVIDERS.map((p) => ({ value: p, label: m.providers[p] }))];
  const statusLabel: Record<LoopState, string> = { running: m.running, starting: m.starting, error: m.error, disabled: m.disabled };
  const statusOptions = [
    { value: "any", label: m.loops.all },
    ...(Object.keys(statusLabel) as LoopState[]).map((v) => ({ value: v, label: statusLabel[v] })),
  ];
  const filters = (
    <>
      <FilterChip
        label={m.bonds.app}
        active={app !== "any"}
        display={app === "any" ? undefined : m.providers[app]}
        onClear={() => setApp("any")}
      >
        <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-48 p-0">
          <FacetedFilter options={appOptions} value={app} onValueChange={(v) => setApp(v as Provider | "any")} />
        </PopoverContent>
      </FilterChip>
      <FilterChip
        label={t.common.status}
        active={status !== "any"}
        display={status === "any" ? undefined : statusLabel[status]}
        onClear={() => setStatus("any")}
      >
        <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-48 p-0">
          <FacetedFilter options={statusOptions} value={status} onValueChange={(v) => setStatus(v as LoopState | "any")} />
        </PopoverContent>
      </FilterChip>
    </>
  );

  const newLoop = <NewLoopButton />;
  // Suggest only templates no Loop uses yet, one row at most.
  const used = new Set(loops.map((l) => l.template));
  const unused = templates.filter((tp) => !used.has(tp.id));
  const suggestions =
    unused.length > 0 ? (
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-fg">{m.loops.suggested}</h2>
          <Link to="/loops/templates" className="text-xs text-fg-muted hover:text-fg">
            {m.loops.viewAllTemplates} →
          </Link>
        </div>
        <TemplateCards templates={unused} limit={3} />
      </section>
    ) : null;

  return (
    <DataTable<Loop>
      headerActions={newLoop}
      searchPlaceholder={m.loops.searchLoops}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={shown}
      loading={loading}
      getRowId={(l) => l.id}
      onRowClick={(l) => nav(loopPath(l.id))}
      rowActions={rowActions}
      columns={columns}
      emptyTitle={error ?? (filtering ? m.loops.noMatch : m.loops.empty)}
      emptySubtitle={error || filtering ? undefined : m.loops.emptyBody}
      emptyAction={error || filtering ? undefined : newLoop}
      footer={error ? undefined : suggestions}
    />
  );
}


/** Template cards, filterable by app; each opens a new Loop from that template. */
function TemplateCards({
  templates,
  query = "",
  limit,
}: {
  templates: LoopTemplate[];
  query?: string;
  /** Show at most this many, without the app tabs. */
  limit?: number;
}) {
  const { t } = useI18n();
  const m = t.matter;
  const [provider, setProvider] = useState<Provider | "all">("all");
  const name = (tp: LoopTemplate) => m.templates[tp.id]?.name ?? tp.name ?? tp.id;
  const description = (tp: LoopTemplate) => m.templates[tp.id]?.description ?? tp.description;
  const q = query.trim().toLowerCase();
  const shown = templates.filter(
    (tp) =>
      (provider === "all" || tp.provider === provider) &&
      (q === "" || `${name(tp)} ${description(tp)} ${m.providers[tp.provider]}`.toLowerCase().includes(q)),
  );
  const tabs: (Provider | "all")[] = ["all", ...PROVIDERS.filter((p) => templates.some((tp) => tp.provider === p))];
  const cards = limit === undefined ? shown : shown.slice(0, limit);
  return (
    <div className="space-y-4">
      {limit === undefined && (
        <div className="flex flex-wrap gap-1" role="tablist">
          {tabs.map((p) => (
            <Button
              key={p}
              size="sm"
              role="tab"
              aria-selected={provider === p}
              variant={provider === p ? "outline" : "ghost"}
              className={provider === p ? "rounded-full" : "rounded-full text-fg-muted"}
              onClick={() => setProvider(p)}
            >
              {p === "all" ? m.loops.all : m.providers[p]}
            </Button>
          ))}
        </div>
      )}
      {cards.length === 0 ? (
        <p className="text-sm text-fg-muted">{m.loops.noTemplates}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((tp) => (
            <Link
              key={tp.id}
              to={`/loops/new?template=${encodeURIComponent(tp.id)}`}
              className="flex flex-col gap-2 rounded-lg border border-border p-4 transition-colors hover:bg-bg-surface"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-fg">
                <ProviderIcon provider={tp.provider} className="size-4 shrink-0" />
                {name(tp)}
              </span>
              <span className="line-clamp-2 text-xs leading-5 text-fg-muted">{description(tp)}</span>
              <span className="mt-auto inline-flex w-fit items-center gap-1 rounded bg-bg-surface px-1.5 py-0.5 text-xs text-fg-muted">
                <ProviderIcon provider={tp.provider} className="size-3" />
                {m.providers[tp.provider]}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** "New Loop": every Loop starts from a built-in template. */
function NewLoopButton() {
  const { t } = useI18n();
  return (
    <Button asChild>
      <Link to="/loops/templates">
        <PlusIcon className="size-4" />
        {t.matter.loops.newLoop}
      </Link>
    </Button>
  );
}

/** `/loops/templates`: every template, searchable. */
export function LoopTemplatesPage() {
  const { t } = useI18n();
  const m = t.matter;
  const { templates, loading, error } = useLoopData();
  const [query, setQuery] = useState("");
  return (
    <Page className="console-settings-page">
      <div className="console-settings-layout">
        <Input
          type="search"
          className="sm:w-80"
          aria-label={m.loops.searchTemplates}
          placeholder={m.loops.searchTemplates}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading ? (
          <MatterNotice>{t.common.loading}</MatterNotice>
        ) : error ? (
          <MatterNotice tone="danger">{error}</MatterNotice>
        ) : (
          <TemplateCards templates={templates} query={query} />
        )}
      </div>
    </Page>
  );
}


/** `/loops/new?template=…` and `/loops/:id`: a Loop's settings page. */
export function LoopEditPage() {
  const { t } = useI18n();
  const m = t.matter;
  const { id } = useParams();
  const [params] = useSearchParams();
  const data = useLoopData();

  if (data.loading) return <LoopPageShell><MatterNotice>{t.common.loading}</MatterNotice></LoopPageShell>;
  if (data.error) return <LoopPageShell><MatterNotice tone="danger">{data.error}</MatterNotice></LoopPageShell>;

  if (id === undefined && !params.get("template")) return <Navigate to="/loops/templates" replace />;

  const loop = id === undefined ? undefined : data.loops.find((l) => l.id === id);
  const template = data.templates.find((tp) => tp.id === (loop?.template ?? params.get("template")));
  if ((id !== undefined && loop === undefined) || template === undefined)
    return <LoopPageShell><MatterNotice>{m.loops.notFound}</MatterNotice></LoopPageShell>;

  return (
    <LoopPageShell>
      <LoopForm
        key={loop?.id ?? template.id}
        template={template}
        loop={loop}
        bonds={data.bonds}
        agents={data.agents}
        environments={data.environments}
        vaults={data.vaults}
        memoryStores={data.memoryStores}
        reload={data.reload}
        reloadBonds={data.reloadBonds}
        initialBond={params.get("bond") ?? undefined}
      />
    </LoopPageShell>
  );
}

function LoopPageShell({ children }: { children: ReactNode }) {
  return (
    <Page className="console-settings-page">
      <div className="console-settings-layout">{children}</div>
    </Page>
  );
}

function LoopForm(props: {
  template: LoopTemplate;
  loop?: Loop;
  bonds: Bond[];
  agents: Agent[] | null;
  environments: Choice[] | null;
  vaults: Choice[] | null;
  memoryStores: Choice[] | null;
  reload: () => Promise<void>;
  reloadBonds: () => Promise<void>;
  /** Preselected Bond, from `/loops/new?bond=…` (the Bond page links here). */
  initialBond?: string;
}) {
  const { t } = useI18n();
  const m = t.matter;
  const nav = useNavigate();
  const { template, loop } = props;
  const fields = Object.entries(template.configSchema.properties);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (loop) return { ...loop.config };
    const initial: Record<string, unknown> = {};
    for (const [key, field] of fields) if (field.default !== undefined) initial[key] = field.default;
    if (template.id === "feishu-agent") initial.acknowledge = "Get";
    // A schedule is read in the browser's time zone unless changed.
    if (fields.some(([key]) => key === "timezone")) initial.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const bondField = fields.find(([, f]) => f["x-oma-widget"] === "bond")?.[0];
    if (bondField && props.initialBond && props.bonds.some((b) => b.id === props.initialBond)) initial[bondField] = props.initialBond;
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  const bondKey = fields.find(([, f]) => f["x-oma-widget"] === "bond")?.[0];
  const agentKey = fields.find(([, f]) => f["x-oma-widget"] === "agent")?.[0];
  const session = (key: string) => fields.some(([k, f]) => k === key && f["x-oma-section"] === "session");
  const options = fields.filter(
    ([key, f]) => key !== bondKey && key !== agentKey && f["x-oma-section"] !== "session" && f["x-oma-section"] !== "trigger",
  );
  const trigger = fields.filter(([, f]) => f["x-oma-section"] === "trigger");
  // Session settings a template adds itself, such as `sessionScope`.
  const sessionOptions = fields.filter(
    ([key, f]) =>
      f["x-oma-section"] === "session" &&
      key !== "environmentId" &&
      key !== "vaultIds" &&
      key !== "memoryStores" &&
      key !== agentKey,
  );
  const environment = typeof values.environmentId === "string" && values.environmentId !== "" ? values.environmentId : "";
  const chosenVaults = Array.isArray(values.vaultIds) ? (values.vaultIds as string[]) : [];
  const required = (key: string) => template.configSchema.required.includes(key);

  const fail = (err: unknown) =>
    setProblems(
      err instanceof MatterError
        ? err.issues.length === err.problems.length && err.issues.length > 0
          ? err.issues.map((issue, i) => issueText(m, issue) ?? err.problems[i]!)
          : err.problems.length
            ? [...err.problems]
            : [err.message]
        : [String(err)],
    );

  async function save() {
    setBusy(true);
    setProblems([]);
    try {
      await matter(loop ? loopPath(loop.id) : "/loops", {
        method: loop ? "PATCH" : "POST",
        body: JSON.stringify(loop ? { config: values } : { template: template.id, config: values }),
      });
      nav("/loops");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(enabled: boolean) {
    if (!loop) return;
    setBusy(true);
    try {
      await matter(loopPath(loop.id), { method: "PATCH", body: JSON.stringify({ enabled }) });
      await props.reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // A scheduled Loop can also be run by hand, e.g. to check it after setup.
  const scheduled = fields.some(([key]) => key === "schedule");
  const [started, setStarted] = useState(false);
  async function runNow() {
    if (!loop) return;
    setBusy(true);
    setProblems([]);
    setStarted(false);
    try {
      await matter(`${loopPath(loop.id)}/run`, { method: "POST" });
      setStarted(true);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!loop || !window.confirm(m.loops.confirmDelete)) return;
    setBusy(true);
    try {
      await matter(loopPath(loop.id), { method: "DELETE" });
      nav("/loops");
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  return (
    <>
      <MatterTitle
        provider={template.provider}
        title={m.templates[template.id]?.name ?? template.name ?? template.id}
        subtitle={m.templates[template.id]?.description ?? template.description}
        status={loop ? <LoopStatus loop={loop} /> : undefined}
      />

      {bondKey && (
        <MatterSection title={m.loops.bond} hint={m.loops.sectionBondHint}>
          <BondField
            provider={template.provider}
            value={typeof values[bondKey] === "string" ? (values[bondKey] as string) : ""}
            onChange={(v) => set(bondKey, v)}
            bonds={props.bonds}
          />
        </MatterSection>
      )}

      {trigger.length > 0 && (
        <MatterSection title={m.loops.sectionTrigger} hint={m.loops.sectionTriggerHint}>
          <div className="space-y-5">
            {trigger.map(([key, field]) => (
              <ConfigField
                key={key}
                name={key}
                field={field}
                required={required(key) || key === "schedule"}
                value={values[key]}
                bond=""
                onChange={(v) => set(key, v)}
              />
            ))}
          </div>
        </MatterSection>
      )}

      {agentKey && (
        <MatterSection title={m.loops.sectionSession} hint={m.loops.sectionSessionHint}>
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="loop-agent">
                {m.loops.agent}
                <span className="text-danger"> *</span>
              </Label>
              <Select
                value={typeof values[agentKey] === "string" ? (values[agentKey] as string) : ""}
                onValueChange={(v) => set(agentKey, v)}
              >
                <SelectTrigger id="loop-agent" aria-label={m.loops.agent} className="w-full sm:w-80">
                  <SelectValue placeholder={props.agents === null ? t.common.loading : m.choose} />
                </SelectTrigger>
                <SelectContent>
                  {(props.agents ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {sessionOptions.map(([key, field]) => (
              <ConfigField
                key={key}
                name={key}
                field={field}
                required={required(key)}
                value={values[key]}
                bond={bondKey && typeof values[bondKey] === "string" ? (values[bondKey] as string) : ""}
                onChange={(v) => set(key, v)}
              />
            ))}
            {session("environmentId") && (
              <div className="space-y-1.5">
                <Label htmlFor="loop-environment">{m.loops.environment}</Label>
                <Select
                  value={environment || DEFAULT_ENVIRONMENT}
                  onValueChange={(v) => set("environmentId", v === DEFAULT_ENVIRONMENT ? undefined : v)}
                >
                  <SelectTrigger id="loop-environment" aria-label={m.loops.environment} className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_ENVIRONMENT}>{m.loops.environmentDefault}</SelectItem>
                    {(props.environments ?? []).map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name}
                      </SelectItem>
                    ))}
                    {environment !== "" && !(props.environments ?? []).some((e) => e.id === environment) && (
                      <SelectItem value={environment}>{environment}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-fg-subtle">{m.loops.environmentHint}</p>
              </div>
            )}
            {session("vaultIds") && (
              <div className="space-y-1.5">
                <Label>{m.loops.vaults}</Label>
                {props.vaults === null ? (
                  <p className="text-sm text-fg-muted">{t.common.loading}</p>
                ) : props.vaults.length === 0 ? (
                  <p className="text-sm text-fg-muted">{m.loops.noVaults}</p>
                ) : (
                  <div className="space-y-1.5">
                    {props.vaults.map((v) => (
                      <Label key={v.id} className="flex items-center gap-2 text-sm font-normal text-fg">
                        <Checkbox
                          aria-label={v.name}
                          checked={chosenVaults.includes(v.id)}
                          onCheckedChange={(on) =>
                            set(
                              "vaultIds",
                              on === true ? [...chosenVaults, v.id] : chosenVaults.filter((id) => id !== v.id),
                            )
                          }
                        />
                        {v.name}
                      </Label>
                    ))}
                  </div>
                )}
                <p className="text-xs text-fg-subtle">{m.loops.vaultsHint}</p>
              </div>
            )}
            {session("memoryStores") && (
              <MemoryStoresField
                stores={props.memoryStores}
                value={Array.isArray(values.memoryStores) ? (values.memoryStores as MemoryStoreChoice[]) : []}
                onChange={(v) => set("memoryStores", v)}
              />
            )}
          </div>
        </MatterSection>
      )}

      {options.length > 0 && (
        <MatterSection title={m.loops.sectionOptions} hint={m.loops.sectionOptionsHint}>
          <div className="space-y-5">
            {options.map(([key, field]) => (
              <ConfigField
                key={key}
                name={key}
                field={field}
                required={required(key)}
                value={values[key]}
                bond={bondKey && typeof values[bondKey] === "string" ? (values[bondKey] as string) : ""}
                onChange={(v) => set(key, v)}
              />
            ))}
          </div>
        </MatterSection>
      )}

      {problems.length > 0 && (
        <div role="alert" className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
          <ul className="list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {started && (
        <div role="status" className="rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-sm text-success">
          {m.runStarted}
        </div>
      )}

      <div className="console-settings-actions">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? t.common.saving : t.common.save}
        </Button>
        <Button variant="ghost" onClick={() => nav("/loops")} disabled={busy}>
          {t.common.cancel}
        </Button>
        {loop && (
          <>
            {scheduled && loop.enabled && (
              <Button variant="outline" className="ml-auto" onClick={() => void runNow()} disabled={busy}>
                {m.runNow}
              </Button>
            )}
            <Button
              variant="outline"
              className={scheduled && loop.enabled ? undefined : "ml-auto"}
              onClick={() => void setEnabled(!loop.enabled)}
              disabled={busy}
            >
              {loop.enabled ? m.disable : m.enable}
            </Button>
            <Button variant="ghost" className="hover:text-danger" onClick={() => void remove()} disabled={busy}>
              {t.common.delete}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

const fill = (text: string, values: Readonly<Record<string, string | number>>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (values[key] === undefined ? all : String(values[key])));

/** A Loop configuration problem in the user's language, or undefined for an unknown code. */
export function issueText(m: Messages["matter"], issue: MatterIssue): string | undefined {
  const template = (m.issues as Record<string, string | undefined>)[issue.code];
  if (template === undefined || issue.code === "item") return undefined;
  const params = issue.params ?? {};
  const field = issue.field === undefined ? "" : (m.fields[issue.field]?.title ?? issue.field);
  const expected = typeof params.expected === "string" ? (m.issueTypes as Record<string, string>)[params.expected] ?? params.expected : "";
  const options =
    typeof params.options === "string"
      ? params.options
          .split(", ")
          .map((o) => m.options[o] ?? o)
          .join(" / ")
      : "";
  const text = fill(template, { ...params, field, expected, options });
  return params.item === undefined ? text : text + fill(m.issues.item, { item: params.item });
}

/** The workspace's Memory Stores to mount in the Loop's sessions, each
 * read-write or read-only. A saved store the list lacks (deleted, or not
 * loaded) is still shown by id, so it can be seen and unchecked. */
function MemoryStoresField(props: {
  stores: Choice[] | null;
  value: MemoryStoreChoice[];
  onChange: (value: MemoryStoreChoice[]) => void;
}) {
  const { t } = useI18n();
  const m = t.matter;
  const listed = props.stores ?? [];
  const rows = [
    ...listed,
    ...props.value.filter((v) => !listed.some((s) => s.id === v.id)).map((v) => ({ id: v.id, name: v.id })),
  ];
  const chosen = (id: string) => props.value.find((v) => v.id === id);
  return (
    <Field label={m.loops.memoryStores} hint={m.loops.memoryStoresHint}>
      <div role="group" aria-label={m.loops.memoryStores} className="space-y-1.5">
        {props.stores === null && props.value.length === 0 ? (
          <p className="text-sm text-fg-muted">{t.common.loading}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">{m.loops.noMemoryStores}</p>
        ) : (
          rows.map((store) => {
            const entry = chosen(store.id);
            return (
              <div key={store.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <Label className="flex min-w-0 items-center gap-2 text-sm font-normal text-fg">
                  <Checkbox
                    aria-label={store.name}
                    checked={entry !== undefined}
                    onCheckedChange={(on) =>
                      props.onChange(
                        on === true
                          ? [...props.value, { id: store.id, access: "read_write" }]
                          : props.value.filter((v) => v.id !== store.id),
                      )
                    }
                  />
                  <span className="truncate">{store.name}</span>
                </Label>
                {entry !== undefined && (
                  <RadioGroup
                    aria-label={fill(m.loops.memoryStoreAccess, { store: store.name })}
                    value={entry.access === "read_only" ? "read_only" : "read_write"}
                    onValueChange={(access) =>
                      props.onChange(
                        props.value.map((v) =>
                          v.id === store.id ? { ...v, access: access as MemoryStoreChoice["access"] } : v,
                        ),
                      )
                    }
                    className="flex items-center gap-3"
                  >
                    {(
                      [
                        ["read_write", m.loops.readWrite],
                        ["read_only", m.loops.readOnly],
                      ] as const
                    ).map(([access, text]) => (
                      <div key={access} className="flex items-center gap-1.5">
                        <RadioGroupItem id={`loop-memory-${store.id}-${access}`} value={access} aria-label={text} />
                        <Label htmlFor={`loop-memory-${store.id}-${access}`} className="text-sm font-normal text-fg-muted">
                          {text}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                )}
              </div>
            );
          })
        )}
      </div>
    </Field>
  );
}

/** Repository URLs, one per line. The text is kept as typed (blank lines
 * included) so a new line can be started; the value drops blank lines. */
function RepositoriesField(props: { id: string; value: string[]; onChange: (value: string[]) => void }) {
  const [text, setText] = useState(() => props.value.join("\n"));
  return (
    <Textarea
      id={props.id}
      rows={3}
      placeholder="https://gitlab.example.com/group/project.git"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        props.onChange(e.target.value.split("\n").map((line) => line.trim()).filter(Boolean));
      }}
    />
  );
}

/** One template option, rendered from its JSON Schema. */
function ConfigField(props: {
  name: string;
  field: FieldSchema;
  required: boolean;
  value: unknown;
  bond: string;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const m = t.matter;
  const { name, field, value, onChange } = props;
  const label = m.fields[name]?.title ?? field.title ?? name;
  const help = m.fields[name]?.description ?? field.description;
  const option = (v: string) => (name === "freshness" && v === "thread" ? m.freshnessThread : (m.options[v] ?? v));
  const id = `loop-${name}`;
  const text = typeof value === "string" ? value : "";

  if (field.type === "boolean")
    return (
      <div className="space-y-1.5">
        <Label className="flex items-center gap-2 text-sm text-fg">
          <Checkbox checked={value === true} onCheckedChange={(v) => onChange(v === true)} />
          {label}
        </Label>
        {help && <p className="text-xs text-fg-subtle">{help}</p>}
      </div>
    );

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {props.required && <span className="text-danger"> *</span>}
      </Label>
      {field["x-oma-widget"] === "repositories" ? (
        <RepositoriesField id={id} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />
      ) : field["x-oma-widget"] === "bond-resources" ? (
        <ResourcesField bond={props.bond} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />
      ) : field.enum ? (
        <Select value={String(value ?? "")} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full sm:w-80">
            <SelectValue placeholder={m.choose} />
          </SelectTrigger>
          <SelectContent>
            {field.enum.map((v) => (
              <SelectItem key={v} value={v}>
                {option(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : name === "instructions" || name === "task" ? (
        <Textarea id={id} rows={4} value={text} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} className="sm:w-80" value={text} onChange={(e) => onChange(e.target.value)} />
      )}
      {help && <p className="text-xs text-fg-subtle">{help}</p>}
    </div>
  );
}

/**
 * Which linked app the Loop runs on. Linking a new one happens on the Bond
 * page, which brings the user back here with the new Bond chosen.
 */
function BondField(props: { provider: Provider; value: string; onChange: (value: string) => void; bonds: Bond[] }) {
  const { t } = useI18n();
  const m = t.matter;
  const { provider } = props;
  const location = useLocation();
  const choices = props.bonds.filter((b) => b.provider === provider);
  const selected = choices.find((b) => b.id === props.value);
  const back = new URLSearchParams(location.search);
  back.delete("bond");
  const query = back.toString();
  const linkTo = `/bonds/new?${new URLSearchParams({ provider, return: `${location.pathname}${query ? `?${query}` : ""}` })}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Select value={props.value} onValueChange={props.onChange} disabled={choices.length === 0}>
          <SelectTrigger aria-label={m.loops.bond} className="w-full sm:w-80">
            <SelectValue placeholder={choices.length === 0 ? m.loops.noBond : m.choose} />
          </SelectTrigger>
          <SelectContent>
            {choices.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <Link to={linkTo}>+ {provider === "feishu" ? m.bonds.linkFeishu : m.bonds.linkGitLab}</Link>
        </Button>
      </div>
      {selected?.provider === "feishu" && <SetupResult setup={selected.setup} />}
    </div>
  );
}

/** Chats or projects of the chosen Bond, as a checklist. */
function ResourcesField(props: { bond: string; value: string[]; onChange: (value: string[]) => void }) {
  const { t } = useI18n();
  const m = t.matter;
  const { bond } = props;
  const [items, setItems] = useState<BondResource[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (bond === "") return;
    let live = true;
    setItems(null);
    matter<{ data: BondResource[] }>(`/bonds/${encodeURIComponent(bond)}/resources`)
      .then((r) => live && setItems(r.data))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [bond]);
  if (bond === "") return <p className="text-sm text-fg-subtle">{m.loops.pickBondFirst}</p>;
  if (items === null) return <p className="text-sm text-fg-subtle">{t.common.loading}</p>;
  // Keep chosen ids the list no longer returns, so saving does not drop them.
  const known = new Set(items.map((i) => i.id));
  const all = [...items, ...props.value.filter((id) => !known.has(id)).map((id) => ({ id, kind: "", title: id }))];
  const shown = all.filter((i) => i.title.toLowerCase().includes(query.toLowerCase()));
  const toggle = (id: string, on: boolean) => props.onChange(on ? [...props.value, id] : props.value.filter((v) => v !== id));
  return (
    <div className="rounded-md border border-border">
      {all.length > 8 && (
        <div className="border-b border-border p-2">
          <Input placeholder={t.common.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      <div className="max-h-56 overflow-y-auto p-1">
        {shown.length === 0 ? (
          <p className="px-2 py-3 text-sm text-fg-subtle">{m.loops.noResources}</p>
        ) : (
          shown.map((i) => (
            <Label key={i.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm font-normal hover:bg-bg-surface">
              <Checkbox checked={props.value.includes(i.id)} onCheckedChange={(v) => toggle(i.id, v === true)} />
              <span className="truncate">{i.title}</span>
            </Label>
          ))
        )}
      </div>
    </div>
  );
}
