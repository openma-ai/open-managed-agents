import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useApiQuery, useInfiniteApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import type { BetaManagedAgentsMemoryStore } from "@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores";
import type {
  BetaManagedAgentsMemory,
  BetaManagedAgentsMemoryListItem,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memories";
import type {
  BetaManagedAgentsActor,
  BetaManagedAgentsMemoryVersion,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions";
import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { Button } from "@/components/ui/button";
import { useI18n } from "../i18n";

type MemoryStore = BetaManagedAgentsMemoryStore;
type MemoryListItem = BetaManagedAgentsMemoryListItem;
type Memory = BetaManagedAgentsMemory;
type MemoryVersion = BetaManagedAgentsMemoryVersion;

type TabKey = "memories" | "versions" | "settings";

export function MemoryStoreDetail() {
  const { id: storeId } = useParams<{ id: string }>();
  const nav = useNavigate();
  const managedApi = useManagedApi();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>("memories");
  const [error, setError] = useState<string | null>(null);

  // Top-level store fetch via TQ. The two child panels do their own
  // queries — this one just gates the page render and seeds the header.
  const { data: store, error: storeError } = useApiQuery<MemoryStore>(
    storeId ? `/v1/memory_stores/${storeId}` : null,
  );
  useEffect(() => {
    if (storeError) setError(errMsg(storeError));
  }, [storeError]);

  // Archive/Delete moved up from the list page when MemoryStoresList
  // adopted the AgentsList chrome — the list rows no longer carry inline
  // actions, so this is where users perform store-level lifecycle ops.
  // Matches AgentDetail's header-actions pattern.
  const archive = async () => {
    if (!storeId) return;
    if (
      !confirm(
        "Archive this store? It will become read-only and no new sessions can attach it. Archive is one-way.",
      )
    )
      return;
    try {
      await managedApi.memoryStores.archive(storeId);
      nav("/memory");
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const del = async () => {
    if (!storeId) return;
    if (
      !confirm(
        "Delete this store and ALL its memories + version history? This cannot be undone.",
      )
    )
      return;
    try {
      await managedApi.memoryStores.delete(storeId);
      nav("/memory");
    } catch (e) {
      setError(errMsg(e));
    }
  };

  if (!storeId) return <div className="p-8">Missing store id.</div>;
  if (error) return (
    <div className="flex-1 p-8">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
    </div>
  );
  if (!store) return <div className="flex-1 p-8 text-fg-muted">Loading...</div>;

  return (
    <Page
      header={
        <PageHeader
          title={store.name}
          subtitle={
            <>
              {store.description && (
                <span className="text-fg-muted">{store.description}</span>
              )}
              <span className="block text-fg-subtle text-xs font-mono mt-1">
                {store.id} · /mnt/memory/{store.name}/
                {store.archived_at && (
                  <span className="ml-2 text-fg-muted">
                    · archived {new Date(store.archived_at).toLocaleDateString()}
                  </span>
                )}
              </span>
            </>
          }
          actions={
            <>
              {!store.archived_at && (
                <Button variant="outline" size="sm" onClick={archive}>
                  Archive
                </Button>
              )}
              <Button variant="destructive" size="sm" onClick={del}>
                Delete
              </Button>
            </>
          }
          toolbar={
            <div
              role="tablist"
              aria-label="Memory store sections"
              className="flex items-center gap-1 -my-1.5"
            >
              <SectionTab
                label="Memories"
                active={tab === "memories"}
                onClick={() => setTab("memories")}
              />
              <SectionTab
                label="Version history"
                active={tab === "versions"}
                onClick={() => setTab("versions")}
              />
              <SectionTab
                label="Settings"
                active={tab === "settings"}
                onClick={() => setTab("settings")}
              />
            </div>
          }
        />
      }
    >
      {tab === "memories" && (
        <MemoriesPanel storeId={storeId} archived={!!store.archived_at} />
      )}
      {tab === "versions" && <VersionsPanel storeId={storeId} />}
      {tab === "settings" && (
        <SettingsPanel
          store={store}
          archived={!!store.archived_at}
          onUpdated={() => {
            if (!storeId) return;
            void queryClient.invalidateQueries({
              queryKey: [`/v1/memory_stores/${storeId}`],
            });
            void queryClient.invalidateQueries({ queryKey: ["/v1/memory_stores"] });
          }}
        />
      )}
    </Page>
  );
}

/** Matches SessionDetail's ViewTab — ghost pill, no underline / muted rail. */
function SectionTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="ghost"
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`inline-flex items-center justify-center px-3 py-2 min-h-11 sm:min-h-0 text-sm rounded-md my-1.5 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
        active
          ? "bg-bg-surface text-brand font-semibold"
          : "text-fg-subtle hover:text-fg-muted hover:bg-bg-surface/60"
      }`}
    >
      {label}
    </Button>
  );
}

// =================================================================
// Memories tab — list, create, view, edit, delete
// =================================================================

function MemoriesPanel({ storeId, archived }: { storeId: string; archived: boolean }) {
  const managedApi = useManagedApi();
  const [error, setError] = useState<string | null>(null);
  const [pathPrefix, setPathPrefix] = useState("");
  const [depth, setDepth] = useState("");
  const [showWrite, setShowWrite] = useState(false);
  const [open, setOpen] = useState<Memory | null>(null);

  // List query — TQ keys on (path, params), so changing pathPrefix/depth
  // gets a fresh cache slot and refetch automatically. The previous hand-
  // rolled load() had the same shape, just without the cache and dedup.
  const params = {
    path_prefix: pathPrefix || undefined,
    depth: depth || undefined,
  };
  const {
    items: memories,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
    error: listError,
    refresh: refetch,
  } = useInfiniteApiQuery<MemoryListItem>(
    `/v1/memory_stores/${storeId}/memories`,
    { limit: 50, params },
  );
  useEffect(() => {
    if (listError) setError(errMsg(listError));
  }, [listError]);
  const load = () => {
    void refetch();
  };

  const openMemory = async (m: Memory) => {
    try {
      const full = await managedApi.memoryStores.memories.retrieve(m.id, {
        memory_store_id: storeId,
        view: "full",
      });
      setOpen(full);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="flex gap-2 mb-4">
        <Input
          placeholder="Filter by path prefix (e.g. /preferences/)"
          aria-label="Filter by path prefix"
          value={pathPrefix}
          onChange={(e) => setPathPrefix(e.target.value)}
          className="flex-1 border border-border rounded-lg px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-border-strong"
        />
        <Input
          placeholder="Depth"
          aria-label="Depth filter"
          value={depth}
          onChange={(e) => setDepth(e.target.value.replace(/[^0-9]/g, ""))}
          className="w-24 border border-border rounded-lg px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-border-strong"
        />
        {!archived && (
          <Button variant="ghost" onClick={() => setShowWrite(true)}
            className="inline-flex items-center justify-center px-4 py-2 min-h-11 sm:min-h-0 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] whitespace-nowrap">
            + New memory
          </Button>
        )}
      </div>

      {showWrite && !archived && (
        <WriteMemoryDialog
          storeId={storeId}
          existing={null}
          onClose={() => setShowWrite(false)}
          onSaved={() => { setShowWrite(false); load(); }}
        />
      )}

      {loading ? <p className="text-fg-subtle text-sm py-4">Loading...</p> : (
        <div className="console-detail-table-wrap">
          <Table className="console-detail-table">
            <TableHeader variant="wireless">
              <TableRow variant="wireless">
                <TableHead>Path</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>SHA-256</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {memories.map((m) =>
                m.type === "memory_prefix" ? (
                  <TableRow
                    variant="wireless"
                    key={`prefix:${m.path}`}
                    onClick={() => setPathPrefix(m.path)}
                    className="cursor-pointer"
                  >
                    <TableCell className="font-mono text-xs">{m.path}</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell className="text-fg-muted">directory</TableCell>
                  </TableRow>
                ) : (
                  <TableRow
                    variant="wireless"
                    key={m.id}
                    onClick={() => openMemory(m)}
                    className="cursor-pointer"
                  >
                    <TableCell className="font-mono text-xs">{m.path}</TableCell>
                    <TableCell>{m.content_size_bytes} B</TableCell>
                    <TableCell className="font-mono text-xs text-fg-muted">{m.content_sha256.slice(0, 12)}…</TableCell>
                    <TableCell className="text-fg-muted">{new Date(m.updated_at).toLocaleString()}</TableCell>
                  </TableRow>
                ),
              )}
              <FeedMoreRow
                colSpan={4}
                hasMore={hasMore}
                loading={isLoadingMore}
                onLoadMore={loadMore}
              />
              {!memories.length && (
                <TableRow><TableCell colSpan={4} className="px-4 py-8 text-center text-fg-subtle">No memories</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {open && (
        <MemoryDetailDialog
          storeId={storeId}
          memory={open}
          archived={archived}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); load(); }}
        />
      )}
    </div>
  );
}

// =================================================================
// Memory detail dialog — view + edit + delete + version history sub-panel
// =================================================================

function MemoryDetailDialog({
  storeId, memory, archived, onClose, onSaved,
}: {
  storeId: string;
  memory: Memory;
  archived: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const managedApi = useManagedApi();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content ?? "");
  const [path, setPath] = useState(memory.path);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  const loadVersions = async () => {
    try {
      const { data } = await managedApi.memoryStores.memoryVersions.list(storeId, {
        memory_id: memory.id,
        view: "full",
        limit: 100,
      });
      setVersions(data);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const save = async () => {
    setError(null);
    try {
      await managedApi.memoryStores.memories.update(memory.id, {
          memory_store_id: storeId,
          path: path !== memory.path ? path : undefined,
          content: content !== (memory.content ?? "") ? content : undefined,
          // CAS guard: refuse to clobber if someone else wrote since we read.
          precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const remove = async () => {
    if (!confirm(`Delete memory "${memory.path}"? Audit history is preserved.`)) return;
    setError(null);
    try {
      await managedApi.memoryStores.memories.delete(memory.id, {
        memory_store_id: storeId,
        expected_content_sha256: memory.content_sha256,
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const rollback = async (v: MemoryVersion) => {
    if (v.content === undefined || v.content === null) {
      alert("This version's content has been redacted — can't roll back.");
      return;
    }
    if (!confirm(`Roll back to version ${v.id} (${new Date(v.created_at).toLocaleString()})?\n\nThis writes a new version with the old content.`)) return;
    setError(null);
    try {
      await managedApi.memoryStores.memories.update(memory.id, {
          memory_store_id: storeId,
          content: v.content,
          // CAS against current head so we don't clobber a concurrent write.
          precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const redact = async (v: MemoryVersion) => {
    if (v.content_sha256 && v.content_sha256 === memory.content_sha256) {
      alert("Can't redact the live head version. Write a new version first or delete the memory.");
      return;
    }
    if (!confirm(`Redact version ${v.id}? Content will be wiped; audit row stays.`)) return;
    setError(null);
    try {
      await managedApi.memoryStores.memoryVersions.redact(v.id, {
        memory_store_id: storeId,
      });
      loadVersions();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={memory.path}
      subtitle={`${memory.id} · sha256=${memory.content_sha256.slice(0, 16)}… · ${memory.content_size_bytes}B`}
      maxWidth="max-w-3xl"
      footer={
        <div className="flex gap-2 w-full">
          {!archived && !editing && (
            <Button variant="ghost"
              onClick={() => setEditing(true)}
              className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              Edit
            </Button>
          )}
          {editing && (
            <>
              <Button variant="ghost"
                onClick={save}
                className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              >
                Save
              </Button>
              <Button variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setContent(memory.content ?? "");
                  setPath(memory.path);
                }}
                className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 border border-border rounded-lg text-sm hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              >
                Cancel
              </Button>
            </>
          )}
          {!editing && (
            <Button variant="ghost"
              onClick={() => {
                setShowVersions((s) => !s);
                if (!showVersions) loadVersions();
              }}
              className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 border border-border rounded-lg text-sm hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              aria-expanded={showVersions}
            >
              {showVersions ? "Hide" : "Show"} version history
            </Button>
          )}
          {!archived && !editing && (
            <Button variant="ghost"
              onClick={remove}
              className="ml-auto inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 bg-danger/10 border border-danger/30 text-danger rounded-lg text-sm hover:bg-danger/20 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              Delete memory
            </Button>
          )}
        </div>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {editing && (
        <div className="mb-3">
          <Label htmlFor="memory-edit-path" className="sr-only">Memory path</Label>
          <Input
            id="memory-edit-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="w-full font-mono text-sm border border-border rounded-lg px-3 py-1.5 min-h-11 sm:min-h-0 bg-bg outline-none focus:border-border-strong"
          />
        </div>
      )}

      {editing ? (
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={20}
          aria-label="Memory content"
          className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-fg font-mono outline-none focus:border-border-strong"
        />
      ) : (
        <pre className="whitespace-pre-wrap bg-bg-surface border border-border rounded-lg p-3 max-h-[40vh] overflow-auto text-sm font-mono text-fg">
          {memory.content || <span className="text-fg-subtle">(empty)</span>}
        </pre>
      )}

      {showVersions && versions && (
        <div className="mt-4 console-detail-table-wrap">
          <Table className="console-detail-table">
            <TableHeader variant="wireless">
              <TableRow variant="wireless">
                <TableHead>When</TableHead>
                <TableHead>Op</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>SHA-256</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => {
                const isLiveHead = v.content_sha256 && v.content_sha256 === memory.content_sha256;
                return (
                  <TableRow variant="wireless" key={v.id}>
                    <TableCell className="px-3 py-2 text-fg-muted">{new Date(v.created_at).toLocaleString()}</TableCell>
                    <TableCell className="px-3 py-2 font-mono">{v.operation}{v.redacted_at && " · redacted"}</TableCell>
                    <TableCell className="px-3 py-2 font-mono text-fg-muted">{formatMemoryActor(v.created_by)}</TableCell>
                    <TableCell className="px-3 py-2 font-mono text-fg-muted">
                      {v.content_sha256 ? v.content_sha256.slice(0, 12) + "…" : "—"}
                      {isLiveHead && <span className="ml-2 text-brand">(head)</span>}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right">
                      {!archived && !v.redacted_at && v.content !== undefined && v.content !== null && !isLiveHead && (
                        <Button variant="ghost" onClick={() => rollback(v)}
                          className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-xs text-brand hover:underline mr-1 sm:mr-2">
                          Roll back
                        </Button>
                      )}
                      {!archived && !v.redacted_at && !isLiveHead && (
                        <Button variant="ghost" onClick={() => redact(v)}
                          className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-xs text-danger hover:underline">
                          Redact
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!versions.length && (
                <TableRow><TableCell colSpan={5} className="px-3 py-4 text-center text-fg-subtle">No versions</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </Modal>
  );
}

// =================================================================
// Versions tab (store-wide audit timeline)
// =================================================================

function VersionsPanel({ storeId }: { storeId: string }) {
  const [error, setError] = useState<string | null>(null);
  const {
    items: versions,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
    error: queryError,
  } = useInfiniteApiQuery<MemoryVersion>(
    `/v1/memory_stores/${storeId}/memory_versions`,
    { limit: 50 },
  );
  useEffect(() => {
    if (queryError) setError(errMsg(queryError));
  }, [queryError]);

  if (error) return <ErrorBanner message={error} onDismiss={() => setError(null)} />;
  if (loading) return <p className="text-fg-subtle text-sm py-4">Loading...</p>;
  if (!versions.length) return <p className="text-fg-subtle text-sm py-4">No versions yet.</p>;

  return (
    <div className="console-detail-table-wrap">
      <Table className="console-detail-table">
        <TableHeader variant="wireless">
          <TableRow variant="wireless">
            <TableHead>When</TableHead>
            <TableHead>Op</TableHead>
            <TableHead>Path</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>SHA-256</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((v) => (
            <TableRow variant="wireless" key={v.id}>
              <TableCell className="px-4 py-3 text-fg-muted">{new Date(v.created_at).toLocaleString()}</TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs">{v.operation}{v.redacted_at && " · redacted"}</TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs">{v.path ?? "—"}</TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs text-fg-muted">{formatMemoryActor(v.created_by)}</TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs text-fg-muted">
                {v.content_sha256 ? v.content_sha256.slice(0, 12) + "…" : "—"}
              </TableCell>
            </TableRow>
          ))}
          <FeedMoreRow
            colSpan={5}
            hasMore={hasMore}
            loading={isLoadingMore}
            onLoadMore={loadMore}
          />
        </TableBody>
      </Table>
    </div>
  );
}

// =================================================================
// Settings tab — editable name/description + read-only ids
// =================================================================

function SettingsPanel({
  store,
  archived,
  onUpdated,
}: {
  store: MemoryStore;
  archived: boolean;
  onUpdated: () => void;
}) {
  const managedApi = useManagedApi();
  const { t } = useI18n();
  const [name, setName] = useState(store.name);
  const [description, setDescription] = useState(store.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep local drafts in sync when the TQ cache refreshes the store.
  useEffect(() => {
    setName(store.name);
    setDescription(store.description ?? "");
  }, [store.id, store.name, store.description]);

  const dirty =
    name.trim() !== store.name ||
    (description.trim() || "") !== (store.description ?? "");

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t.common.nameRequired);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await managedApi.memoryStores.update(store.id, {
        name: trimmedName,
        description: description.trim() || null,
      });
      onUpdated();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  return (
    <div className="space-y-4 text-sm max-w-xl">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div>
        <div className="text-fg-muted text-xs uppercase tracking-wider mb-1">{t.common.id}</div>
        <code className="font-mono text-xs">{store.id}</code>
      </div>

      <div>
        <Label htmlFor="memory-store-name" className="text-fg-muted text-xs uppercase tracking-wider mb-1 block">
          {t.common.name}
        </Label>
        <Input
          id="memory-store-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={archived || saving}
          className={inputCls}
        />
        <p className="text-fg-subtle text-xs mt-1">
          {t.memory.mountPathHint}{" "}
          <code className="font-mono">/mnt/memory/{name.trim() || store.name}/</code>
        </p>
      </div>

      <div>
        <Label htmlFor="memory-store-desc" className="text-fg-muted text-xs uppercase tracking-wider mb-1 block">
          {t.common.description}
        </Label>
        <Textarea
          id="memory-store-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={archived || saving}
          rows={3}
          className={`${inputCls} resize-y`}
        />
      </div>

      <div>
        <div className="text-fg-muted text-xs uppercase tracking-wider mb-1">{t.common.created}</div>
        <span>{new Date(store.created_at).toLocaleString()}</span>
      </div>
      {archived && (
        <div>
          <div className="text-fg-muted text-xs uppercase tracking-wider mb-1">{t.common.archived}</div>
          <span>{new Date(store.archived_at!).toLocaleString()}</span>
        </div>
      )}

      {!archived && (
        <div className="flex items-center gap-2 pt-2">
          <Button onClick={save} disabled={saving || !dirty || !name.trim()}>
            {saving ? t.common.saving : t.common.saveChanges}
          </Button>
          {dirty && (
            <Button variant="ghost"
              onClick={() => {
                setName(store.name);
                setDescription(store.description ?? "");
                setError(null);
              }}
              disabled={saving}
              className="text-xs text-fg-muted hover:text-fg"
            >
              {t.common.reset}
            </Button>
          )}
        </div>
      )}

      <p className="text-fg-subtle text-xs pt-4 border-t border-border">
        {t.memory.settingsArchiveHint}
      </p>
    </div>
  );
}

// =================================================================
// Write memory dialog (create or first-write)
// =================================================================

function WriteMemoryDialog({
  storeId, existing, onClose, onSaved,
}: {
  storeId: string;
  existing: Memory | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const managedApi = useManagedApi();
  const [path, setPath] = useState(existing?.path ?? "/");
  const [content, setContent] = useState(existing?.content ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      await managedApi.memoryStores.memories.create(storeId, { path, content });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New memory"
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost"
            onClick={onClose}
            className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 border border-border rounded-lg text-sm hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Cancel
          </Button>
          <Button variant="ghost"
            onClick={save}
            className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Create
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Label htmlFor="new-memory-path" className="block text-xs font-medium uppercase tracking-wider text-fg-muted mb-1">Path</Label>
      <Input
        id="new-memory-path"
        placeholder="/preferences/formatting.md"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        className="w-full font-mono border border-border rounded-lg px-3 py-2 text-sm mb-3 bg-bg text-fg outline-none focus:border-border-strong"
      />

      <Label htmlFor="new-memory-content" className="block text-xs font-medium uppercase tracking-wider text-fg-muted mb-1">Content (max 100KB)</Label>
      <Textarea
        id="new-memory-content"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={14}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-fg font-mono outline-none focus:border-border-strong"
      />
    </Modal>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3 mb-4 flex items-start justify-between gap-4">
      <p className="text-danger text-sm">{message}</p>
      <Button variant="ghost" onClick={onDismiss} className="inline-flex items-center min-h-11 sm:min-h-0 text-danger/70 hover:text-danger text-sm flex-shrink-0">Dismiss</Button>
    </div>
  );
}

function formatMemoryActor(actor: BetaManagedAgentsActor | undefined): string {
  if (!actor) return "—";
  switch (actor.type) {
    case "api_actor":
      return `${actor.type}:${actor.api_key_id}`;
    case "session_actor":
      return `${actor.type}:${actor.session_id}`;
    case "user_actor":
      return `${actor.type}:${actor.user_id}`;
    case "service_account_actor":
      return `${actor.type}:${actor.service_account_id}`;
  }
}

function FeedMoreRow({
  colSpan,
  hasMore,
  loading,
  onLoadMore,
}: {
  colSpan: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore || loading || !ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  if (!hasMore) return null;
  return (
    <TableRow variant="wireless">
      <TableCell colSpan={colSpan} className="text-center text-xs text-fg-subtle">
        <div ref={ref}>{loading ? "Loading more…" : "More items load as you scroll"}</div>
      </TableCell>
    </TableRow>
  );
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}
