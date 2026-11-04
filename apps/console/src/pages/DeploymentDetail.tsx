import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { ArchiveIcon, PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import type { BetaManagedAgentsDeploymentRun } from "@anthropic-ai/sdk/resources/beta/deployment-runs";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { OpenmaStartupLoader } from "../components/OpenmaStartupLoader";
import { Page } from "../components/Page";
import { useI18n } from "../i18n";
import { ApiError } from "../lib/api";
import { useApiQuery, useInfiniteApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { centsToDollars, readBudgetCap } from "./session-detail/budget";
import {
  deploymentCreator,
  deploymentState,
  DeploymentStatePill,
  fill,
  formatRunTime,
  TriggerSummary,
  type Deployment,
} from "./deployments/shared";

type DeploymentRun = BetaManagedAgentsDeploymentRun;

/** Text of the `user.message` events a run sends first. */
function initialMessageText(deployment: Deployment): string {
  return deployment.initial_events
    .flatMap((event) => (event.type === "user.message" ? event.content : []))
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function DeploymentDetail() {
  const { id = "" } = useParams();
  const managedApi = useManagedApi();
  const queryClient = useQueryClient();
  const { t, locale } = useI18n();
  const m = t.deployments;

  const [busy, setBusy] = useState(false);
  const query = useApiQuery<Deployment>(`/v1/deployments/${encodeURIComponent(id)}`, undefined, { retry: false });
  const deployment = query.data?.id === id ? query.data : null;
  const missing = query.error instanceof ApiError && query.error.status === 404;
  const load = query.refetch;

  const runsParams = useMemo(() => ({ deployment_id: id }), [id]);
  const runs = useInfiniteApiQuery<DeploymentRun>("/v1/deployment_runs", {
    limit: 20,
    params: runsParams,
  });

  const act = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    try {
      await action();
      void queryClient.invalidateQueries({ queryKey: ["/v1/deployments"] });
      await load();
      after?.();
    } catch {
      // The API client already toasts the failure.
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <Page className="console-settings-page">
        <p className="text-sm text-fg-muted">{m.notFound}</p>
      </Page>
    );
  }
  if (query.error) {
    return <Page className="console-settings-page">
      <p role="alert" className="text-sm text-danger">{m.loadFailed}</p>
      <Button variant="outline" onClick={() => void load()}>{m.retry}</Button>
    </Page>;
  }
  if (!deployment) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <OpenmaStartupLoader />
      </div>
    );
  }

  const state = deploymentState(deployment);
  const archived = state === "archived";
  const budget = readBudgetCap(deployment.budget);
  const message = initialMessageText(deployment);
  const pausedReason = deployment.paused_reason;

  const runNow = () =>
    act(
      () => managedApi.deployments.run(deployment.id),
      () => {
        toast.success(m.runStarted);
        runs.refresh();
      },
    );
  const togglePause = () =>
    act(() =>
      state === "paused"
        ? managedApi.deployments.unpause(deployment.id)
        : managedApi.deployments.pause(deployment.id),
    );
  const archive = () => {
    if (!window.confirm(fill(m.confirmArchive, { name: deployment.name }))) return;
    void act(() => managedApi.deployments.archive(deployment.id));
  };

  return (
    <Page className="console-settings-page">
      <div className="console-settings-layout">
        <section className="console-settings-intro">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1>{deployment.name}</h1>
                <DeploymentStatePill deployment={deployment} m={m} />
              </div>
              <p className="mt-1 font-mono text-xs text-fg-subtle">{deployment.id}</p>
              {deployment.description && (
                <p className="mt-2 text-sm text-fg-muted">{deployment.description}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void runNow()} disabled={busy || state !== "active"}>
                <PlayIcon className="size-4" aria-hidden="true" />
                {m.runNow}
              </Button>
              <Button variant="outline" onClick={() => void togglePause()} disabled={busy || archived}>
                {state === "paused" ? (
                  <RotateCcwIcon className="size-4" aria-hidden="true" />
                ) : (
                  <PauseIcon className="size-4" aria-hidden="true" />
                )}
                {state === "paused" ? m.resume : m.pause}
              </Button>
              <Button variant="outline" onClick={archive} disabled={busy || archived}>
                <ArchiveIcon className="size-4" aria-hidden="true" />
                {m.archive}
              </Button>
            </div>
          </div>
          {archived ? (
            <Notice>{m.archivedNotice}</Notice>
          ) : pausedReason ? (
            <Notice tone="warning">
              {pausedReason.type === "error"
                ? fill(m.pausedByError, { error: pausedReason.error.type })
                : m.pausedManually}
            </Notice>
          ) : null}
        </section>

        <section className="console-settings-section" aria-labelledby="deployment-properties">
          <header className="console-settings-section-header">
            <h2 id="deployment-properties">{m.properties}</h2>
          </header>
          <dl className="console-settings-section-body grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[160px_minmax(0,1fr)]">
            <Property label={m.agent}>
              <Link className="font-mono text-xs text-brand hover:underline" to={`/agents/${deployment.agent.id}`}>
                {deployment.agent.id}
              </Link>{" "}
              <span className="text-fg-subtle">
                {fill(m.agentVersion, { version: deployment.agent.version })}
              </span>
            </Property>
            <Property label={m.environment}>
              <Link
                className="font-mono text-xs text-brand hover:underline"
                to={`/environments/${deployment.environment_id}`}
              >
                {deployment.environment_id}
              </Link>
            </Property>
            <Property label={m.trigger}>
              <TriggerSummary deployment={deployment} m={m} />
            </Property>
            {deployment.schedule && (
              <>
                <Property label={m.lastRun}>
                  {deployment.schedule.last_run_at
                    ? formatRunTime(deployment.schedule.last_run_at, locale)
                    : m.none}
                </Property>
                <Property label={m.upcomingRuns}>
                  {deployment.schedule.upcoming_runs_at?.length ? (
                    <ul className="space-y-0.5">
                      {deployment.schedule.upcoming_runs_at.map((at) => (
                        <li key={at}>{formatRunTime(at, locale, deployment.schedule!.timezone)}</li>
                      ))}
                    </ul>
                  ) : (
                    m.none
                  )}
                </Property>
              </>
            )}
            <Property label={m.initialMessage}>
              <p className="whitespace-pre-wrap">{message || m.none}</p>
            </Property>
            <Property label={m.budget}>{budget ? centsToDollars(budget.amount) : m.none}</Property>
            <Property label={m.vaults}>
              {deployment.vault_ids.length ? (
                <ul className="space-y-0.5">
                  {deployment.vault_ids.map((vaultId) => (
                    <li key={vaultId}>
                      <Link className="font-mono text-xs text-brand hover:underline" to={`/vaults/${vaultId}`}>
                        {vaultId}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                m.none
              )}
            </Property>
            <Property label={m.sessionResources}>
              {deployment.resources.length ? (
                <ul className="space-y-0.5">
                  {deployment.resources.map((resource, index) => (
                    <li key={index} className="font-mono text-xs">
                      {resource.type === "github_repository"
                        ? `${m.githubRepository}: ${resource.url}${
                            resource.checkout
                              ? ` @ ${resource.checkout.type === "branch" ? resource.checkout.name : resource.checkout.sha}`
                              : ""
                          }`
                        : resource.type === "file"
                          ? `${m.file}: ${resource.file_id}`
                          : `${m.memoryStore}: ${resource.memory_store_id} (${
                              resource.access === "read_only" ? m.readOnly : m.readWrite
                            })`}
                    </li>
                  ))}
                </ul>
              ) : (
                m.none
              )}
            </Property>
            <Property label={m.createdBy}>{deploymentCreator(deployment) ?? "—"}</Property>
            <Property label={m.created}>{formatRunTime(deployment.created_at, locale)}</Property>
            <Property label={m.updated}>{formatRunTime(deployment.updated_at, locale)}</Property>
          </dl>
        </section>

        <section className="console-settings-section" aria-labelledby="deployment-runs">
          <header className="console-settings-section-header">
            <div>
              <h2 id="deployment-runs">{m.runs}</h2>
              <p>{m.runsHint}</p>
            </div>
          </header>
          <div className="console-settings-section-body">
            {runs.error ? (
              <p role="alert" className="text-sm text-danger">{m.loadFailed} <Button variant="outline" size="sm" onClick={runs.refresh}>{m.retry}</Button></p>
            ) : runs.isLoading ? (
              <p className="text-sm text-fg-subtle">{t.common.loading}</p>
            ) : runs.items.length === 0 ? (
              <p className="text-sm text-fg-subtle">{m.runsEmpty}</p>
            ) : (
              <RunsTable runs={runs.items} locale={locale} />
            )}
            {runs.hasMore && (
              <Button
                className="mt-3"
                variant="outline"
                size="sm"
                loading={runs.isLoadingMore}
                onClick={runs.loadMore}
              >
                {m.loadMore}
              </Button>
            )}
          </div>
        </section>
      </div>
    </Page>
  );
}

function RunsTable({ runs, locale }: { runs: DeploymentRun[]; locale: string }) {
  const { t } = useI18n();
  const m = t.deployments;
  return (
    <Table aria-label={m.runs}>
      <TableHeader>
        <TableRow>
          <TableHead>{m.run}</TableHead>
          <TableHead>{m.trigger}</TableHead>
          <TableHead>{m.result}</TableHead>
          <TableHead>{m.created}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell className="font-mono text-xs text-fg-muted">{run.id}</TableCell>
            <TableCell className="text-fg-muted">
              {run.trigger_context.type === "schedule"
                ? `${m.schedule} · ${formatRunTime(run.trigger_context.scheduled_at, locale)}`
                : m.manual}
            </TableCell>
            <TableCell>
              {run.error ? (
                <span className="text-danger" title={run.error.type}>
                  {m.runFailed}: {run.error.message}
                </span>
              ) : run.session_id ? (
                <Link className="text-brand hover:underline" to={`/sessions/${run.session_id}`}>
                  {m.runSucceeded}
                </Link>
              ) : (
                <span className="text-fg-subtle">—</span>
              )}
            </TableCell>
            <TableCell className="text-fg-muted">{formatRunTime(run.created_at, locale)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </>
  );
}

function Notice({ children, tone }: { children: ReactNode; tone?: "warning" }) {
  return (
    <p
      role="status"
      className={
        tone === "warning"
          ? "rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning"
          : "rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-fg-muted"
      }
    >
      {children}
    </p>
  );
}
