import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useState, type ReactNode } from "react";
import { ArrowRightIcon, CheckIcon, CopyIcon } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { StatusPill } from "../components/Badge";
import {
  ConsolePanel,
  DashboardLayout,
  KpiCard,
} from "../components/ConsoleSurface";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { useI18n } from "../i18n";
import { useApiQuery } from "../lib/useApiQuery";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";

interface Stats {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
}

function QuickstartStep({
  number,
  title,
  children,
}: {
  number: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="console-quickstart-step">
      <div>
        <div className="console-step-index">STEP {number}</div>
        <div className="console-step-title">{title}</div>
      </div>
      <div className="console-step-body">{children}</div>
    </div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const [copied, setCopied] = useState<string | null>(null);
  const { t } = useI18n();
  const statsQuery = useApiQuery<Stats>("/v1/oma/stats");
  const sessionsQuery = useApiQuery<{
    data: BetaManagedAgentsSession[];
    next_page: string | null;
    prev_page: string | null;
  }>(
    "/v1/sessions",
    { limit: "5" },
  );
  const stats = statsQuery.data;
  const recentSessions = sessionsQuery.data?.data.slice(0, 5) ?? [];

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    toast.success(t.common.copied);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const primaryKpis = [
    { label: t.nav.agents, value: stats?.agents, to: "/agents" },
    { label: t.nav.sessions, value: stats?.sessions, to: "/sessions" },
    { label: t.nav.environments, value: stats?.environments, to: "/environments" },
    { label: t.nav.credentialVaults, value: stats?.vaults, to: "/vaults" },
  ];
  const secondaryStats = [
    { label: t.nav.skills, value: stats?.skills, to: "/skills" },
    { label: t.nav.modelCards, value: stats?.model_cards, to: "/model-cards" },
  ];

  const command = "npx -y -p @openma/cli oma";
  const globalCommand = "npm i -g @openma/cli";
  const examplePrompt =
    "Use oma to create a research agent that monitors arXiv for new ML papers daily";

  const copyIcon = (key: string) =>
    copied === key ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />;

  return (
    <DashboardLayout
      intro={
        <header>
          <h1>Get started with openma</h1>
          <p>{t.dashboard.handPlatformToAgent}</p>
        </header>
      }
      kpis={primaryKpis.map((kpi) => (
        <KpiCard
          key={kpi.to}
          label={kpi.label}
          value={kpi.value}
          onClick={() => navigate(kpi.to)}
        />
      ))}
      secondary={
        <div className="console-secondary-stats" data-testid="dashboard-secondary-stats">
          {secondaryStats.map((stat) => (
            <Button
              key={stat.to}
              variant="ghost"
              type="button"
              className="console-secondary-stat"
              onClick={() => navigate(stat.to)}
            >
              <span>{stat.label}</span>
              <strong>{stat.value ?? "–"}</strong>
            </Button>
          ))}
        </div>
      }
    >
      <ConsolePanel
        title="Launch an agent"
        description="A short path from an empty workspace to a managed run."
      >
        <QuickstartStep number="01" title={t.dashboard.installCli}>
          <p>{t.dashboard.installCliDesc}</p>
          <Button
            variant="ghost"
            type="button"
            className="console-copy-control"
            onClick={() => void copy(command, "command")}
          >
            <span>{command}</span>
            {copyIcon("command")}
          </Button>
          <p className="mt-1.5 text-xs text-fg-subtle">
            or globally:{" "}
            <Button
              variant="ghost"
              type="button"
              className="font-mono text-fg-muted hover:text-brand"
              onClick={() => void copy(globalCommand, "global-command")}
            >
              {globalCommand}
            </Button>
          </p>
        </QuickstartStep>

        <QuickstartStep number="02" title={t.dashboard.mintApiKey}>
          <p>{t.dashboard.mintApiKeyDesc}</p>
          <Button variant="ghost"
            type="button"
            className="mt-2 inline-flex h-[var(--control-h)] items-center gap-1.5 rounded-md bg-brand px-3 text-sm font-medium text-brand-fg hover:bg-brand-hover"
            onClick={() => navigate("/api-keys")}
          >
            {t.dashboard.generateApiKey}
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </QuickstartStep>

        <QuickstartStep number="03" title={t.dashboard.handItReins}>
          <p>{t.dashboard.handItReinsDesc}</p>
          <Button variant="ghost"
            type="button"
            className="console-copy-control"
            onClick={() => void copy(examplePrompt, "prompt")}
          >
            <span>{examplePrompt}</span>
            {copyIcon("prompt")}
          </Button>
        </QuickstartStep>
      </ConsolePanel>

      <ConsolePanel
        title={t.dashboard.recentSessions}
        description="Latest activity across the current workspace."
        action={
          <Button variant="ghost"
            type="button"
            className="text-sm text-fg-muted hover:text-brand"
            onClick={() => navigate("/sessions")}
          >
            {t.common.viewAll}
          </Button>
        }
      >
        {sessionsQuery.isLoading ? (
          <div>
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className="flex h-[var(--data-row-h)] items-center gap-3 border-t border-border first:border-t-0 px-3"
              >
                <Skeleton className="h-3 w-[42%]" rounded="sm" />
                <Skeleton className="ml-auto h-3 w-16" rounded="sm" />
              </div>
            ))}
          </div>
        ) : recentSessions.length === 0 ? (
          <div className="p-3">
            <EmptyState
              title={t.dashboard.noSessionsYet}
              body={t.dashboard.visitSessionsPage}
            />
          </div>
        ) : (
          <div className="console-dashboard-table-wrap">
            <Table className="console-dashboard-table">
              <colgroup>
                <col style={{ width: "40%" }} />
                <col style={{ width: "20%" }} />
                <col style={{ width: "24%" }} />
                <col style={{ width: "16%" }} />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.dashboard.title}</TableHead>
                  <TableHead>{t.common.status}</TableHead>
                  <TableHead>{t.dashboard.agent}</TableHead>
                  <TableHead>{t.common.created}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentSessions.map((session) => (
                  <TableRow key={session.id} onClick={() => navigate(`/sessions/${session.id}`)}>
                    <TableCell className="text-fg">{session.title || t.dashboard.untitled}</TableCell>
                    <TableCell><StatusPill status={session.status || "idle"} /></TableCell>
                    <TableCell className="font-mono text-xs text-fg-muted">{session.agent.id}</TableCell>
                    <TableCell className="text-xs text-fg-muted">
                      {new Date(session.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </ConsolePanel>
    </DashboardLayout>
  );
}
