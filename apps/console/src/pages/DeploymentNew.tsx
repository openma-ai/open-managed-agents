import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useBlocker, useNavigate } from "react-router";
import type { DeploymentCreateParams } from "@anthropic-ai/sdk/resources/beta/deployments";
import {
  ArrowUpRightIcon,
  CalendarIcon,
  ChevronDownIcon,
  ClockIcon,
  FileIcon,
  DatabaseIcon,
  GitBranchIcon,
  HandIcon,
  InfoIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { Combobox } from "../components/Combobox";
import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { Select, SelectOption } from "../components/Select";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import {
  browserTimeZone,
  buildCronExpression,
  formatClockTime,
  listTimeZones,
  nextCronRuns,
  parseClockTime,
  parseCron,
  timeZoneLabel,
  type CronFrequency,
} from "../lib/cron";
import { useQueryClient } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { dollarsToCents } from "./session-detail/budget";
import {
  CREATED_BY_METADATA_KEY,
  fill,
  FormSection,
  formatRunTime,
  SearchPicker,
} from "./deployments/shared";

type ResourceDraft =
  | {
      key: number;
      kind: "github";
      url: string;
      token: string;
      checkout: "none" | "branch" | "commit";
      ref: string;
      mountPath: string;
    }
  | { key: number; kind: "file"; fileId: string; mountPath: string; mode: "upload" | "id"; filename: string }
  | {
      key: number;
      kind: "memory_store";
      storeId: string;
      access: "read_write" | "read_only";
      instructions: string;
    };

type ResourceKind = ResourceDraft["kind"];

interface DeploymentDraft {
  name: string;
  agentId: string;
  environmentId: string;
  message: string;
  budget: string;
  trigger: "manual" | "schedule";
  frequency: CronFrequency;
  /** "9:00" — hour and minute for daily/weekday/weekly presets. */
  time: string;
  meridiem: "AM" | "PM";
  /** Minute past the hour for the hourly preset. */
  minute: string;
  weekday: number;
  timezone: string;
  cron: string;
  vaultIds: string[];
  resources: ResourceDraft[];
}

const FREQUENCIES: CronFrequency[] = ["every_minute", "hourly", "daily", "weekdays", "weekly", "custom"];

function blankDraft(): DeploymentDraft {
  return {
    name: "",
    agentId: "",
    environmentId: "",
    message: "",
    budget: "",
    trigger: "manual",
    frequency: "weekdays",
    time: "9:00",
    meridiem: "AM",
    minute: "0",
    weekday: 1,
    timezone: browserTimeZone(),
    cron: "0 9 * * 1-5",
    vaultIds: [],
    resources: [],
  };
}

/** The draft's cron expression, or null when the time fields are invalid. */
function draftExpression(draft: DeploymentDraft): string | null {
  if (draft.frequency === "custom") return draft.cron.trim();
  if (draft.frequency === "every_minute") {
    return buildCronExpression({ frequency: "every_minute", hour: 0, minute: 0, weekday: 0 });
  }
  if (draft.frequency === "hourly") {
    if (!/^\d{1,2}$/.test(draft.minute.trim()) || Number(draft.minute) > 59) return null;
    return buildCronExpression({ frequency: "hourly", hour: 0, minute: Number(draft.minute), weekday: 0 });
  }
  const clock = parseClockTime(draft.time, draft.meridiem);
  if (!clock) return null;
  return buildCronExpression({ frequency: draft.frequency, ...clock, weekday: draft.weekday });
}

type Resource = NonNullable<DeploymentCreateParams["resources"]>[number];

function toResource(draft: ResourceDraft): Resource {
  switch (draft.kind) {
    case "github": {
      const resource: Resource = {
        type: "github_repository",
        url: draft.url.trim(),
        authorization_token: draft.token,
      };
      if (draft.checkout === "branch") resource.checkout = { type: "branch", name: draft.ref.trim() };
      if (draft.checkout === "commit") resource.checkout = { type: "commit", sha: draft.ref.trim() };
      if (draft.mountPath.trim()) resource.mount_path = draft.mountPath.trim();
      return resource;
    }
    case "file":
      return {
        type: "file",
        file_id: draft.fileId,
        ...(draft.mountPath.trim() ? { mount_path: draft.mountPath.trim() } : {}),
      };
    case "memory_store":
      return {
        type: "memory_store",
        memory_store_id: draft.storeId,
        access: draft.access,
        ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
      };
  }
}

interface Choice {
  id: string;
  name: string;
  updated_at?: string;
  config?: { type: string };
  scope?: string;
}

export function DeploymentNew() {
  const managedApi = useManagedApi();
  const queryClient = useQueryClient();
  const nav = useNavigate();
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const m = t.deployments;

  const [initial] = useState(blankDraft);
  const [draft, setDraft] = useState<DeploymentDraft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [vaults, setVaults] = useState<Choice[]>([]);
  const [stores, setStores] = useState<Choice[]>([]);
  const nextKey = useRef(1);
  const leaving = useRef(false);

  const set = <K extends keyof DeploymentDraft>(key: K, value: DeploymentDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      managedApi.vaults.list({ limit: 200 }).catch(() => ({ data: [] })),
      managedApi.memoryStores.list({ limit: 200 }).catch(() => ({ data: [] })),
    ]).then(([vaultPage, storePage]) => {
      if (cancelled) return;
      setVaults(vaultPage.data.map((vault) => ({ id: vault.id, name: vault.display_name })));
      setStores(storePage.data.map((store) => ({ id: store.id, name: store.name })));
    });
    return () => {
      cancelled = true;
    };
  }, [managedApi]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ── Schedule ──
  const expression = draft.trigger === "schedule" ? draftExpression(draft) : null;
  const cronCheck = expression ? parseCron(expression) : null;
  const upcoming = useMemo(
    () => (expression && cronCheck?.ok ? nextCronRuns(expression, draft.timezone, 5) : []),
    [expression, cronCheck?.ok, draft.timezone],
  );
  const timeZones = useMemo(() => {
    const now = new Date();
    const zones = listTimeZones();
    if (!zones.includes(initial.timezone)) zones.unshift(initial.timezone);
    return zones.map((zone) => ({ value: zone, label: timeZoneLabel(zone, now) }));
  }, [initial.timezone]);

  // ── Validation (shown after the first submit attempt) ──
  const required = (field: string) => fill(m.required, { field });
  const budgetCents = draft.budget.trim() ? dollarsToCents(draft.budget) : null;
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = required(m.name);
  if (!draft.agentId) errors.agent = required(m.agent);
  if (!draft.environmentId) errors.environment = required(m.environment);
  if (!draft.message.trim()) errors.message = required(m.initialMessage);
  if (draft.budget.trim() && !budgetCents) errors.budget = m.budgetInvalid;
  if (draft.trigger === "schedule") {
    if (!expression) errors.schedule = m.invalidTime;
    else if (cronCheck && !cronCheck.ok) errors.schedule = m.invalidCron;
    else if (upcoming.length === 0) errors.schedule = m.noUpcomingRuns;
  }
  draft.resources.forEach((resource, index) => {
    if (resource.kind === "github") {
      if (!resource.url.trim()) errors[`resource.${index}.url`] = required(m.repositoryUrl);
      if (!resource.token) errors[`resource.${index}.token`] = required(m.authorizationToken);
      if (resource.checkout !== "none" && !resource.ref.trim()) {
        errors[`resource.${index}.ref`] = required(resource.checkout === "branch" ? m.branchName : m.commitSha);
      }
    } else if (resource.kind === "file") {
      if (!resource.fileId) errors[`resource.${index}.file`] = required(m.file);
    } else if (!resource.storeId) {
      errors[`resource.${index}.store`] = required(m.memoryStore);
    }
  });
  const errorFor = (key: string) => (submitted ? errors[key] : undefined);

  const submit = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const params: DeploymentCreateParams = {
      name: draft.name.trim(),
      agent: draft.agentId,
      environment_id: draft.environmentId,
      initial_events: [
        { type: "user.message", content: [{ type: "text", text: draft.message.trim() }] },
      ],
    };
    if (budgetCents) {
      params.budget = { type: "limit", max_list_cost: { amount: budgetCents, currency: "USD" } };
    }
    if (draft.trigger === "schedule" && expression) {
      params.schedule = { type: "cron", expression, timezone: draft.timezone };
    }
    if (draft.vaultIds.length > 0) params.vault_ids = draft.vaultIds;
    if (draft.resources.length > 0) params.resources = draft.resources.map(toResource);
    if (user?.email) params.metadata = { [CREATED_BY_METADATA_KEY]: user.email };

    setSaving(true);
    try {
      const deployment = await managedApi.deployments.create(params);
      void queryClient.invalidateQueries({ queryKey: ["/v1/deployments"] });
      leaving.current = true;
      nav(`/deployments/${deployment.id}`);
    } catch {
      // The API client already toasts the failure; keep the form for a retry.
    } finally {
      setSaving(false);
    }
  };

  // ── Resources ──
  const addResource = (kind: ResourceKind) => {
    const key = nextKey.current++;
    const resource: ResourceDraft =
      kind === "github"
        ? { key, kind, url: "", token: "", checkout: "none", ref: "", mountPath: "" }
        : kind === "file"
          ? { key, kind, fileId: "", mountPath: "", mode: "upload", filename: "" }
          : { key, kind, storeId: "", access: "read_write", instructions: "" };
    set("resources", [...draft.resources, resource]);
  };
  const updateResource = (key: number, patch: Partial<ResourceDraft>) =>
    setDraft((current) => ({
      ...current,
      resources: current.resources.map((resource) =>
        resource.key === key ? ({ ...resource, ...patch } as ResourceDraft) : resource,
      ),
    }));
  const removeResource = (index: number) =>
    set("resources", draft.resources.filter((_, i) => i !== index));

  const kindLabel = (kind: ResourceKind) =>
    kind === "github" ? m.githubRepository : kind === "file" ? m.file : m.memoryStore;

  const vaultNames = new Map(vaults.map((vault) => [vault.id, vault.name]));
  const vaultOptions = vaults
    .filter((vault) => !draft.vaultIds.includes(vault.id))
    .map((vault) => ({ value: vault.id, label: `${vault.name} (${vault.id})` }));

  return (
    <Page className="console-settings-page">
      <nav className="mb-5 text-sm text-fg-muted" aria-label={m.newDeployment}><Link to="/deployments">{t.nav.deployments}</Link> / {m.newDeployment}</nav>
      <form
        className="mx-auto w-full max-w-3xl [&>section:first-of-type]:border-t-0 [&>section:first-of-type]:pt-0"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className="sticky top-0 z-10 mb-8 bg-bg py-3">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{m.createDeployment}</h1>
          <p className="mt-1 text-sm text-fg-muted">{m.newSubtitle}</p>
        </header>

        <FormSection title={m.general} hint={m.generalHint}>
          <Field id="deployment-name" label={m.name} error={errorFor("name")}>
            <Input
              autoFocus
              id="deployment-name"
              name="oma-deployment-name"
              autoComplete="off"
              value={draft.name}
              placeholder={m.namePlaceholder}
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field
            id="deployment-agent"
            label={m.agent}
            error={errorFor("agent")}
            aside={<ManageLink to="/agents" label={m.manageAgents} />}
          >
            <Combobox<Choice>
              id="deployment-agent"
              value={draft.agentId}
              onValueChange={(value) => set("agentId", value)}
              searchPlaceholder={m.searchAgents}
              emptyText={m.noAgents}
              endpoint="/v1/agents"
              getValue={(agent) => agent.id}
              getLabel={(agent) => (
                <span>
                  {agent.name} <span className="text-sm text-fg-subtle">({agent.id})</span>
                </span>
              )}
              getTextLabel={(agent) => `${agent.name} (${agent.id})`}
              placeholder={m.selectAgent}
            />
          </Field>
          <Field
            id="deployment-environment"
            label={m.environment}
            error={errorFor("environment")}
            aside={<ManageLink to="/environments" label={m.manageEnvironments} />}
          >
            <Combobox<Choice>
              id="deployment-environment"
              value={draft.environmentId}
              onValueChange={(value) => set("environmentId", value)}
              searchPlaceholder={m.searchEnvironments}
              emptyText={m.noEnvironments}
              endpoint="/v1/environments"
              getValue={(environment) => environment.id}
              getLabel={(environment) => (
                <span>
                  {environment.name}
                  <span className="block text-xs text-fg-subtle">{environment.updated_at && new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-Math.floor((Date.now() - Date.parse(environment.updated_at)) / 86400000), "day")} · {environment.config?.type === "cloud" ? m.cloud : environment.config?.type} · {environment.scope === "organization" ? m.organization : environment.scope === "account" ? m.account : "—"}</span>
                </span>
              )}
              getTextLabel={(environment) => `${environment.name} (${environment.id})`}
              placeholder={m.selectEnvironment}
            />
          </Field>
          <Field
            id="deployment-message"
            label={m.initialMessage}
            hintAfter
            hint={m.initialMessageHint}
            error={errorFor("message")}
          >
            <Textarea
              id="deployment-message"
              rows={3}
              value={draft.message}
              placeholder={m.initialMessagePlaceholder}
              onChange={(event) => set("message", event.target.value)}
            />
          </Field>
          <Field
            id="deployment-budget"
            label={m.budget}
            optional={m.optional}
            hint={m.budgetHint}
            error={errorFor("budget")}
          >
            <Input
              id="deployment-budget"
              inputMode="decimal"
              autoComplete="off"
              value={draft.budget}
              placeholder="$"
              onChange={(event) => set("budget", event.target.value)}
            />
          </Field>
        </FormSection>

        <FormSection title={m.trigger} hint={m.triggerHint}>
          <Tabs
            value={draft.trigger}
            onValueChange={(value) => set("trigger", value as DeploymentDraft["trigger"])}
          >
            <TabsList className="grid w-full grid-cols-2" aria-label={m.trigger}>
              <TabsTrigger value="manual">
                <HandIcon className="size-4" aria-hidden="true" />
                {m.manual}
              </TabsTrigger>
              <TabsTrigger value="schedule">
                <CalendarIcon className="size-4" aria-hidden="true" />
                {m.schedule}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {draft.trigger === "manual" ? (
            <p className="text-sm text-fg-muted">
              {m.manualHint} <code className="rounded bg-bg-surface px-1 py-0.5 font-mono text-xs">POST /v1/deployments/:id/run</code>.
            </p>
          ) : (
            <ScheduleFields
              draft={draft}
              set={set}
              expression={expression}
              upcoming={upcoming}
              timeZones={timeZones}
              error={errorFor("schedule")}
              locale={locale}
            />
          )}
        </FormSection>

        <FormSection title={m.resources} hint={m.resourcesHint}>
          <Field
            label={m.vaults}
            optional={m.optional}
            aside={<ManageLink to="/vaults" label={m.manageVaults} />}
          >
            {draft.vaultIds.length > 0 && (
              <ul className="mb-2 space-y-1">
                {draft.vaultIds.map((id) => (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {vaultNames.get(id) ?? id}{" "}
                      <span className="font-mono text-xs text-fg-subtle">{id}</span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={fill(m.removeVault, { name: vaultNames.get(id) ?? id })}
                      onClick={() => set("vaultIds", draft.vaultIds.filter((vaultId) => vaultId !== id))}
                    >
                      <Trash2Icon />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <SearchPicker
              variant="ghost"
              icon={<PlusIcon className="size-4" aria-hidden="true" />}
              label={m.addVault}
              options={vaultOptions}
              value=""
              onValueChange={(id) => set("vaultIds", [...draft.vaultIds, id])}
              searchPlaceholder={m.searchVaults}
              empty={m.noVaults}
            />
          </Field>

          <Field label={m.sessionResources} optional={m.optional} hint={m.sessionResourcesHint}>
            <div className="space-y-3">
              {draft.resources.map((resource, index) => (
                <div key={resource.key} className="rounded-lg border border-border p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-fg">{kindLabel(resource.kind)}</span>
                    {resource.kind === "memory_store" && <ManageLink to="/memory" label={m.manageMemoryStores} />}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={fill(m.removeResource, { kind: kindLabel(resource.kind) })}
                      onClick={() => removeResource(index)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  <ResourceFields
                    resource={resource}
                    index={index}
                    update={(patch) => updateResource(resource.key, patch)}
                    stores={stores}
                    errorFor={errorFor}
                  />
                </div>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    {m.addResource}
                    <ChevronDownIcon className="size-3.5" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-48">
                  <DropdownMenuItem onSelect={() => addResource("github")}>
                    <GitBranchIcon /> {m.githubRepository}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addResource("file")}>
                    <FileIcon /> {m.file}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addResource("memory_store")}>
                    <DatabaseIcon /> {m.memoryStore}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </Field>
        </FormSection>

        <div className="sticky bottom-0 z-10 flex justify-end gap-2 border-t border-border bg-bg py-4">
          <Button type="button" variant="outline" onClick={() => nav("/deployments")}>
            {t.common.cancel}
          </Button>
          <Button type="submit" loading={saving} disabled={saving}>
            {m.createDeployment}
          </Button>
        </div>
      </form>

      <Modal
        confirmation
        maxWidth="max-w-md"
        open={blocker.state === "blocked"}
        onClose={() => blocker.reset?.()}
        title={m.unsavedTitle}
        footer={
          <>
            <Button variant="outline" onClick={() => blocker.reset?.()}>
              {m.stay}
            </Button>
            <Button variant="destructive" onClick={() => blocker.proceed?.()}>
              {m.leave}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-muted">{m.unsavedBody}</p>
      </Modal>
    </Page>
  );
}

function ScheduleFields({
  draft,
  set,
  expression,
  upcoming,
  timeZones,
  error,
  locale,
}: {
  draft: DeploymentDraft;
  set: <K extends keyof DeploymentDraft>(key: K, value: DeploymentDraft[K]) => void;
  expression: string | null;
  upcoming: Date[];
  timeZones: { value: string; label: string }[];
  error?: string;
  locale: string;
}) {
  const { t } = useI18n();
  const m = t.deployments;
  const zoneLabel = timeZones.find((zone) => zone.value === draft.timezone)?.label ?? draft.timezone;
  const usesClock = draft.frequency === "daily" || draft.frequency === "weekdays" || draft.frequency === "weekly";

  const changeFrequency = (frequency: CronFrequency) => {
    // Entering the custom editor starts from the schedule built so far.
    if (frequency === "custom" && expression) set("cron", expression);
    set("frequency", frequency);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="deployment-frequency" label={m.frequency}>
          <Select
            position="popper"
            id="deployment-frequency"
            value={draft.frequency}
            onValueChange={(value) => changeFrequency(value as CronFrequency)}
          >
            {FREQUENCIES.map((frequency) => (
              <SelectOption key={frequency} value={frequency}>
                {m.frequencies[frequency]}
              </SelectOption>
            ))}
          </Select>
        </Field>
        <Field id="deployment-timezone" label={m.timezone}>
          <SearchPicker
            id="deployment-timezone"
            label={zoneLabel}
            options={timeZones}
            value={draft.timezone}
            onValueChange={(zone) => set("timezone", zone)}
            searchPlaceholder={m.timezone}
          />
        </Field>
      </div>

      {draft.frequency === "custom" ? (
        <Field id="deployment-cron" label={m.cronExpression} hintAfter hint={m.cronHint} error={error}>
          <Input
            id="deployment-cron"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            value={draft.cron}
            onChange={(event) => set("cron", event.target.value)}
          />
        </Field>
      ) : (
        <>
          {draft.frequency === "hourly" && (
            <Field id="deployment-minute" label={m.atMinute} error={error}>
              <Input
                id="deployment-minute"
                className="w-32"
                inputMode="numeric"
                value={draft.minute}
                onChange={(event) => set("minute", event.target.value)}
              />
            </Field>
          )}
          {usesClock && (
            <div className="flex flex-wrap items-end gap-4">
              {draft.frequency === "weekly" && (
                <Field id="deployment-weekday" label={m.day}>
                  <Select
            position="popper"
                    id="deployment-weekday"
                    className="w-40"
                    value={String(draft.weekday)}
                    onValueChange={(value) => set("weekday", Number(value))}
                  >
                    {m.weekdayNames.map((name, index) => (
                      <SelectOption key={index} value={String(index)}>
                        {name}
                      </SelectOption>
                    ))}
                  </Select>
                </Field>
              )}
              <Field id="deployment-time" label={m.at} error={error}>
                <div className="flex items-center gap-2">
                  <Input
                    id="deployment-time"
                    className="w-32"
                    autoComplete="off"
                    value={draft.time}
                    onChange={(event) => set("time", event.target.value)}
                    onBlur={() => {
                      const clock = parseClockTime(draft.time, draft.meridiem);
                      if (clock) set("time", formatClockTime(clock.hour, clock.minute).text);
                    }}
                  />
                  <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label={m.meridiem}>
                    {(["AM", "PM"] as const).map((meridiem) => (
                      <Button
                        key={meridiem === "AM" ? m.am : m.pm}
                        type="button"
                        size="xs"
                        variant={draft.meridiem === meridiem ? "secondary" : "ghost"}
                        aria-pressed={draft.meridiem === meridiem}
                        onClick={() => set("meridiem", meridiem)}
                      >
                        {meridiem === "AM" ? m.am : m.pm}
                      </Button>
                    ))}
                  </div>
                </div>
              </Field>
            </div>
          )}
          {expression && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-bg-surface px-3 py-2">
              <code className="font-mono text-xs text-fg-muted" data-testid="cron-preview">
                {expression}
              </code>
              <Button type="button" variant="link" size="xs" onClick={() => changeFrequency("custom")}>
                {m.editCron}
              </Button>
            </div>
          )}
        </>
      )}

      <div>
        <div className="mb-2 flex items-center gap-1 text-sm font-medium text-fg">
          {m.nextRuns}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-xs" className="text-fg-subtle" aria-label={m.nextRunsHint}>
                  <InfoIcon className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">{m.nextRunsHint}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {upcoming.length > 0 ? (
          <ul className="space-y-1" aria-label={m.nextRuns}>
            {upcoming.map((run) => (
              <li key={run.toISOString()} className="flex items-center gap-2 text-sm text-fg-muted">
                <ClockIcon className="size-3.5" aria-hidden="true" />
                {formatRunTime(run, locale, draft.timezone)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-subtle">{m.noUpcomingRuns}</p>
        )}
      </div>
    </div>
  );
}

function ResourceFields({
  resource,
  index,
  update,
  stores,
  errorFor,
}: {
  resource: ResourceDraft;
  index: number;
  update: (patch: Partial<ResourceDraft>) => void;
  stores: Choice[];
  errorFor: (key: string) => string | undefined;
}) {
  const { t } = useI18n();
  const m = t.deployments;
  const managedApi = useManagedApi();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const upload = async (file?: File) => {
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(false);
    try {
      const result = await managedApi.files.upload({ file });
      update({ fileId: result.id, filename: result.filename });
    } catch { setUploadError(true); } finally { setUploading(false); }
  };
  const id = (field: string) => `deployment-resource-${index}-${field}`;

  if (resource.kind === "github") {
    return (
      <div className="space-y-3">
        <Field id={id("url")} label={m.repositoryUrl} error={errorFor(`resource.${index}.url`)}>
          <Input
            id={id("url")}
            className="font-mono"
            autoComplete="off"
            value={resource.url}
            placeholder="https://github.com/owner/repo"
            onChange={(event) => update({ url: event.target.value })}
          />
        </Field>
        <Field id={id("token")} label={m.authorizationToken} error={errorFor(`resource.${index}.token`)}>
          <Input
            id={id("token")}
            type="password"
            className="font-mono"
            autoComplete="off"
            value={resource.token}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            onChange={(event) => update({ token: event.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("checkout")} label={m.checkout} optional={m.optional}>
            <Select
            position="popper"
              id={id("checkout")}
              value={resource.checkout}
              onValueChange={(value) =>
                update({ checkout: value as "none" | "branch" | "commit", ref: "" })
              }
            >
              <SelectOption value="none">{m.checkoutNone}</SelectOption>
              <SelectOption value="branch">{m.checkoutBranch}</SelectOption>
              <SelectOption value="commit">{m.checkoutCommit}</SelectOption>
            </Select>
          </Field>
          {resource.checkout !== "none" && (
            <Field
              id={id("ref")}
              label={resource.checkout === "branch" ? m.branchName : m.commitSha}
              error={errorFor(`resource.${index}.ref`)}
            >
              <Input
                id={id("ref")}
                className="font-mono"
                autoComplete="off"
                value={resource.ref}
                placeholder={resource.checkout === "branch" ? "main" : "abc123..."}
                onChange={(event) => update({ ref: event.target.value })}
              />
            </Field>
          )}
        </div>
        <Field id={id("mount")} label={m.mountPath} optional={m.optional}>
          <Input
            id={id("mount")}
            className="font-mono"
            autoComplete="off"
            value={resource.mountPath}
            placeholder={m.repositoryMountPlaceholder}
            onChange={(event) => update({ mountPath: event.target.value })}
          />
        </Field>
      </div>
    );
  }

  if (resource.kind === "file") {
    return (
      <div className="space-y-3">
        <Tabs value={resource.mode} onValueChange={(mode) => update({ mode: mode as "upload" | "id" })}>
          <TabsList aria-label={m.file}>
            <TabsTrigger value="upload">{m.upload}</TabsTrigger>
            <TabsTrigger value="id">{m.fileId}</TabsTrigger>
          </TabsList>
        </Tabs>
        {resource.mode === "upload" ? (
          <div className="rounded-lg border border-border p-4 text-center" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}>
            <p className="mb-3 text-sm">{uploading ? m.uploading : resource.filename || m.dropFile}</p>
            <Label htmlFor={id("upload")} className="inline-flex cursor-pointer rounded-md border border-border px-3 py-1.5">{m.chooseFile}</Label>
            <Input id={id("upload")} aria-label={m.chooseFile} type="file" className="sr-only" disabled={uploading} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
          </div>
        ) : (
          <Field id={id("file")} label={m.fileId} error={errorFor(`resource.${index}.file`)}>
            <Input id={id("file")} value={resource.fileId} placeholder="file_..." onChange={(event) => update({ fileId: event.target.value })} />
          </Field>
        )}
        {uploadError && <p role="alert" className="text-sm text-danger">{m.uploadFailed}</p>}
        {errorFor(`resource.${index}.file`) && resource.mode === "upload" && <p role="alert" className="text-sm text-danger">{errorFor(`resource.${index}.file`)}</p>}
        <Field id={id("mount")} label={m.mountPath} hideLabel>
          <Input
            id={id("mount")}
            className="font-mono"
            autoComplete="off"
            value={resource.mountPath}
            placeholder={m.fileMountPlaceholder}
            onChange={(event) => update({ mountPath: event.target.value })}
          />
        </Field>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field
        id={id("store")}
        label={m.memoryStore}
        error={errorFor(`resource.${index}.store`)}
        hideLabel
      >
        <Select
            position="popper"
          id={id("store")}
          value={resource.storeId}
          placeholder={m.selectMemoryStore}
          onValueChange={(value) => update({ storeId: value })}
        >
          {stores.map((store) => (
            <SelectOption key={store.id} value={store.id}>
              {store.name} ({store.id})
            </SelectOption>
          ))}
        </Select>
      </Field>
      <Field id={id("access")} label={m.access}>
        <Select
            position="popper"
          id={id("access")}
          value={resource.access}
          onValueChange={(value) => update({ access: value as "read_write" | "read_only" })}
        >
          <SelectOption value="read_write">{m.readWrite}</SelectOption>
          <SelectOption value="read_only">{m.readOnly}</SelectOption>
        </Select>
      </Field>
      <Field id={id("instructions")} label={m.instructions} optional={m.optional}>
        <Textarea
          id={id("instructions")}
          rows={2}
          maxLength={4096}
          value={resource.instructions}
          placeholder={m.instructionsPlaceholder}
          onChange={(event) => update({ instructions: event.target.value })}
        />
      </Field>
    </div>
  );
}

function Field({
  id,
  label,
  optional,
  hint,
  hintAfter,
  hideLabel,
  error,
  aside,
  children,
}: {
  id?: string;
  label: string;
  optional?: string;
  hint?: string;
  hintAfter?: boolean;
  hideLabel?: boolean;
  error?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className={hideLabel ? "sr-only" : "mb-1.5 flex items-center justify-between gap-2"}>
        <Label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
          {optional && <span className="font-normal text-fg-subtle"> {optional}</span>}
        </Label>
        {aside}
      </div>
      {hint && !hintAfter && <p className="mb-1.5 whitespace-pre-line text-xs text-fg-subtle">{hint}</p>}
      {children}
      {hint && hintAfter && <p className="mt-1.5 text-xs text-fg-subtle">{hint}</p>}
      {error && (
        <p className="mt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ManageLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-xs text-brand hover:underline"
    >
      {label}
      <ArrowUpRightIcon className="size-3" aria-hidden="true" />
    </Link>
  );
}
