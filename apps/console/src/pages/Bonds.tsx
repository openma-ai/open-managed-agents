import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronRightIcon } from "lucide-react";
import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { DataTable, type ColumnDef } from "../components/DataTable";
import { Page } from "../components/Page";
import type { RowAction } from "../components/RowContextMenu";
import { useI18n } from "../i18n";
import { matter, MatterError, type Bond, type Loop } from "../lib/matter";
import {
  bondPath,
  FeishuLinker,
  GitLabLinker,
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
 * Bonds: the apps Matter acts through — a Feishu bot, a GitLab bot account.
 * Loops run on them; a Bond with Loops on it cannot be unlinked.
 */
export function BondsPage() {
  const { t } = useI18n();
  const m = t.matter;
  const errorText = useMatterError();
  const [bonds, setBonds] = useState<Bond[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      setBonds((await matter<{ data: Bond[] }>("/bonds")).data);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
    // errorText only reads the current locale's messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function unlink(bond: Bond): Promise<string | null> {
    if (!window.confirm(m.bonds.confirmDelete)) return null;
    try {
      await matter(`/bonds/${encodeURIComponent(bond.id)}`, { method: "DELETE" });
      await load();
      return null;
    } catch (err) {
      return err instanceof MatterError && err.status === 409 ? m.bonds.inUse : m.bonds.linkFailed;
    }
  }

  const rowActions = (bond: Bond): RowAction[] => [
    {
      label: t.common.delete,
      destructive: true,
      disabled: bond.loops > 0,
      onSelect: () => void unlink(bond).then((msg) => msg && window.alert(msg)),
    },
  ];

  const columns = useMemo<ColumnDef<Bond>[]>(
    () => [
      {
        id: "app",
        header: m.bonds.app,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2 font-medium text-fg">
            <ProviderIcon provider={row.original.provider} className="size-4" />
            {row.original.label}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "provider",
        header: m.bonds.provider,
        cell: ({ row }) => <span className="text-fg-muted">{m.providers[row.original.provider]}</span>,
      },
      {
        id: "loops",
        header: m.bonds.loops,
        cell: ({ row }) => <span className="text-fg-muted tabular-nums">{row.original.loops}</span>,
      },
      {
        id: "status",
        header: t.common.status,
        cell: ({ row }) => <BondStatus bond={row.original} />,
      },
      {
        id: "connected",
        header: m.bonds.connected,
        cell: ({ row }) => (
          <span className="text-fg-muted">{new Date(row.original.connectedAt).toLocaleDateString()}</span>
        ),
      },
    ],
    [t, m],
  );

  const linkApp = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <PlusIcon className="size-4" />
          {m.bonds.linkApp}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => nav("/bonds/new?provider=feishu")}>
          <ProviderIcon provider="feishu" className="size-4" />
          {m.bonds.linkFeishu}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => nav("/bonds/new?provider=gitlab")}>
          <ProviderIcon provider="gitlab" className="size-4" />
          {m.bonds.linkGitLab}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <DataTable<Bond>
      headerActions={linkApp}
      data={bonds}
      loading={loading}
      getRowId={(b) => b.id}
      onRowClick={(b) => nav(bondPath(b.id))}
      rowActions={rowActions}
      columns={columns}
      emptyTitle={error ?? m.bonds.empty}
      emptySubtitle={error ? undefined : m.bonds.emptyBody}
      emptyAction={error ? undefined : linkApp}
    />
  );
}

function BondStatus({ bond }: { bond: Bond }) {
  const { t } = useI18n();
  const m = t.matter;
  if (bond.lastError)
    return (
      <span title={`${m.lastError}: ${bond.lastError.message}`}>
        <StatusPill tone="danger">{m.error}</StatusPill>
      </span>
    );
  if (bond.setup && !bond.setup.ready) return <StatusPill tone="warning">{m.bonds.setupNeeded}</StatusPill>;
  return bond.running ? <StatusPill tone="success">{m.running}</StatusPill> : <StatusPill tone="muted">{m.stopped}</StatusPill>;
}

function BondPageShell({ children }: { children: ReactNode }) {
  return (
    <Page className="console-settings-page">
      <div className="console-settings-layout">{children}</div>
    </Page>
  );
}

/** `/bonds/:id`: what the app is, what it still needs, and the Loops on it. */
export function BondDetailPage() {
  const { t } = useI18n();
  const m = t.matter;
  const nav = useNavigate();
  const errorText = useMatterError();
  const id = useParams().id ?? "";
  const [bond, setBond] = useState<Bond | null | undefined>(undefined);
  const [loops, setLoops] = useState<Loop[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([matter<{ data: Bond[] }>("/bonds"), matter<{ data: Loop[] }>("/loops")])
      .then(([bd, lp]) => {
        if (!live) return;
        setBond(bd.data.find((b) => b.id === id) ?? null);
        setLoops(lp.data.filter((l) => l.config.bond === id));
      })
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
    // errorText only reads the current locale's messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return <BondPageShell><MatterNotice tone="danger">{error}</MatterNotice></BondPageShell>;
  if (bond === undefined) return <BondPageShell><MatterNotice>{t.common.loading}</MatterNotice></BondPageShell>;
  if (bond === null) return <BondPageShell><MatterNotice>{m.bonds.notFound}</MatterNotice></BondPageShell>;

  const labels = m.bonds.detail as Record<string, string>;
  // `brand` repeats the provider shown in the title.
  const details = Object.entries(bond.details).filter(([k, v]) => k !== "brand" && typeof v === "string" && v !== "") as [
    string,
    string,
  ][];
  const newLoop = bond.provider === "feishu" ? `/loops/new?template=feishu-agent&bond=${encodeURIComponent(bond.id)}` : "/loops";

  async function unlink() {
    if (!bond || !window.confirm(m.bonds.confirmDelete)) return;
    setBusy(true);
    try {
      await matter(`/bonds/${encodeURIComponent(bond.id)}`, { method: "DELETE" });
      nav("/bonds");
    } catch (err) {
      setMessage(err instanceof MatterError && err.status === 409 ? m.bonds.inUse : m.bonds.linkFailed);
      setBusy(false);
    }
  }

  return (
    <BondPageShell>
      <MatterTitle provider={bond.provider} title={bond.label} subtitle={m.providers[bond.provider]} status={<BondStatus bond={bond} />} />

      <MatterSection title={m.bonds.sectionInfo}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          {details.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-muted">{labels[k] ?? k}</dt>
              <dd className="truncate font-mono text-xs leading-5 text-fg">{v}</dd>
            </div>
          ))}
          <dt className="text-fg-muted">{m.bonds.connected}</dt>
          <dd className="text-fg">{new Date(bond.connectedAt).toLocaleString()}</dd>
          {bond.lastError && (
            <>
              <dt className="text-fg-muted">{m.lastError}</dt>
              <dd className="break-words text-danger">{bond.lastError.message}</dd>
            </>
          )}
        </dl>
      </MatterSection>

      {bond.provider === "feishu" && (
        <MatterSection title={m.bonds.sectionSetup} hint={m.bonds.sectionSetupHint}>
          <SetupResult setup={bond.setup} />
        </MatterSection>
      )}

      <MatterSection
        title={m.bonds.usedBy}
        flush={loops.length > 0}
        action={
          <Button asChild size="sm" variant="outline">
            <Link to={newLoop}>{m.loops.newLoop}</Link>
          </Button>
        }
      >
        {loops.length === 0 ? (
          <p className="text-sm text-fg-muted">{m.bonds.noLoops}</p>
        ) : (
          loops.map((l) => (
            <Link key={l.id} to={loopPath(l.id)} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-surface">
              <ProviderIcon provider={bond.provider} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{m.templates[l.template]?.name ?? l.template}</span>
              {!l.enabled && <StatusPill tone="muted">{m.disabled}</StatusPill>}
              <ChevronRightIcon className="size-4 shrink-0 text-fg-subtle" />
            </Link>
          ))
        )}
      </MatterSection>

      {message && <MatterNotice tone="danger">{message}</MatterNotice>}

      <div className="console-settings-actions">
        <Button variant="ghost" onClick={() => nav("/bonds")}>
          {m.back}
        </Button>
        <Button
          variant="ghost"
          className="ml-auto hover:text-danger"
          disabled={busy || loops.length > 0}
          title={loops.length > 0 ? m.bonds.inUse : undefined}
          onClick={() => void unlink()}
        >
          {t.common.delete}
        </Button>
      </div>
    </BondPageShell>
  );
}

/** `/bonds/new?provider=feishu|gitlab`: link an app. */
export function BondLinkPage() {
  const { t } = useI18n();
  const m = t.matter;
  const nav = useNavigate();
  const [params] = useSearchParams();
  const provider: Provider = params.get("provider") === "gitlab" ? "gitlab" : "feishu";
  const done = (id: string) => nav(bondPath(id));
  return (
    <BondPageShell>
      <MatterTitle provider={provider} title={provider === "feishu" ? m.bonds.linkFeishu : m.bonds.linkGitLab} />
      <MatterSection title={m.providers[provider]} hint={provider === "feishu" ? undefined : m.bonds.gitlabHint}>
        {provider === "feishu" ? <FeishuLinker onLinked={done} /> : <GitLabLinker onLinked={done} />}
      </MatterSection>
      <div className="console-settings-actions">
        <Button variant="ghost" onClick={() => nav("/bonds")}>
          {t.common.cancel}
        </Button>
      </div>
    </BondPageShell>
  );
}
