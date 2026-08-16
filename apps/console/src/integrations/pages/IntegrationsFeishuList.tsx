import { useEffect, useState } from "react";
import { Link } from "react-router";
import { IntegrationsApi } from "../api/client";
import { Avatar } from "../../components/Avatar";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill } from "../components/StatusPill";
import type { FeishuInstallation, FeishuPublication } from "../api/types";

const api = new IntegrationsApi();

interface InstallationWithPublications {
  installation: FeishuInstallation;
  publications: FeishuPublication[];
}

export function IntegrationsFeishuList() {
  const [items, setItems] = useState<InstallationWithPublications[]>([]);
  const [pending, setPending] = useState<FeishuPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [installs, pendingPubs] = await Promise.all([
        api.feishu.listInstallations(),
        api.feishu.listPendingPublications(),
      ]);
      const withPubs = await Promise.all(
        installs.map(async (installation) => ({
          installation,
          publications: await api.feishu.listPublications(installation.id),
        })),
      );
      setItems(withPubs);
      setPending(pendingPubs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function discardPending(pubId: string) {
    try {
      await api.feishu.unpublish(pubId);
      setPending((p) => p.filter((x) => x.id !== pubId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-8 lg:px-10 py-10 lg:py-12">
        <header className="flex items-start justify-between gap-6 mb-8">
          <div className="min-w-0">
            <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
              Feishu integrations
            </h1>
            <p className="mt-1.5 text-[14px] text-fg-muted max-w-xl">
              Connect your agents to Feishu — they can join chats, reply to messages,
              and react across your tenant.
            </p>
          </div>
          <Link
            to="/integrations/feishu/publish"
            className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] whitespace-nowrap"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Publish agent
          </Link>
        </header>

        {loading && <p className="text-sm text-fg-muted">Loading…</p>}
        {error && (
          <div className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {pending.length > 0 && (
          <section className="mb-6">
            <h2 className="text-[12px] font-medium text-fg-muted uppercase tracking-wider mb-2">
              In-progress installs
            </h2>
            <ul className="space-y-2">
              {pending.map((p) => (
                <PendingRow
                  key={p.id}
                  pub={p}
                  onDiscard={() => discardPending(p.id)}
                />
              ))}
            </ul>
          </section>
        )}

        {!loading && items.length === 0 && pending.length === 0 && (
          <EmptyState
            title="No Feishu tenants connected yet."
            action={
              <Link
                to="/integrations/feishu/publish"
                className="text-brand hover:underline text-[13px]"
              >
                Connect your first tenant →
              </Link>
            }
          />
        )}

        <div className="space-y-3">
          {items.map(({ installation, publications }) => (
            <TenantCard
              key={installation.id}
              installation={installation}
              publications={publications}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** In-progress row mirrors Slack's: persona + step number + Resume / Discard.
 *  Feishu's state machine elides `credentials_filled` (jumps pending_setup →
 *  live in one shot on submitCredentials), so two states are enough: step 1
 *  for `pending_setup`, step 2 for `awaiting_install`. */
function PendingRow({
  pub,
  onDiscard,
}: {
  pub: FeishuPublication;
  onDiscard: () => void;
}) {
  const stepNum = pub.status === "pending_setup" ? 1 : 2;
  const statusLabel =
    pub.status === "pending_setup"
      ? "Pending setup"
      : pub.status === "awaiting_install"
        ? "Awaiting install"
        : "Pending";
  return (
    <li className="flex items-center gap-3 px-4 py-3 rounded-md border border-warning/30 bg-warning-subtle/40">
      <Avatar src={pub.persona.avatarUrl} name={pub.persona.name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-fg text-[14px] truncate">
            {pub.persona.name}
          </span>
          <span className="text-[11px] text-warning">
            ● Step {stepNum} of 2 ({statusLabel})
          </span>
        </div>
        <p className="text-[12px] text-fg-muted">
          Started {new Date(pub.created_at).toLocaleString()}
        </p>
      </div>
      <Link
        to={`/integrations/feishu/publish?pub=${encodeURIComponent(pub.id)}`}
        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-medium rounded-md bg-brand text-brand-fg hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
      >
        Resume install ↗
      </Link>
      <button
        type="button"
        onClick={onDiscard}
        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-medium text-fg-muted hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        title="Discard this in-progress install"
      >
        Discard ✕
      </button>
    </li>
  );
}

function TenantCard({
  installation,
  publications,
}: {
  installation: FeishuInstallation;
  publications: FeishuPublication[];
}) {
  const tenantLabel =
    installation.tenant_type === "internal" ? "Internal tenant" : "External tenant";
  return (
    <div className="border border-border rounded-lg overflow-hidden bg-bg hover:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-medium text-fg truncate">
              {installation.tenant_name}
            </h2>
            <span className="text-[11px] text-fg-subtle font-mono uppercase tracking-wider">
              {tenantLabel}
            </span>
          </div>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            Dedicated bot · full identity ·{" "}
            <span className="text-fg">
              {publications.length} agent{publications.length === 1 ? "" : "s"}
            </span>
          </p>
        </div>
        <Link
          to={`/integrations/feishu/installations/${installation.id}`}
          className="shrink-0 text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          Manage →
        </Link>
      </div>

      {publications.length > 0 && (
        <ul className="border-t border-border divide-y divide-border bg-bg-surface/20">
          {publications.map((p) => (
            <PublicationRow key={p.id} pub={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PublicationRow({ pub }: { pub: FeishuPublication }) {
  return (
    <li className="flex items-center gap-3 px-5 py-2.5 text-sm">
      <Avatar src={pub.persona.avatarUrl} name={pub.persona.name} size="sm" />
      <span className="font-medium text-fg flex-1 truncate">{pub.persona.name}</span>
      <StatusPill status={pub.status} />
    </li>
  );
}
