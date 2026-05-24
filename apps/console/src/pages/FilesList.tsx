import { useMemo, useState } from "react";
import { Link } from "react-router";
import { DownloadIcon, TrashIcon } from "lucide-react";
import { useApi, getActiveTenantId } from "../lib/api";
import { toast } from "sonner";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { useApiQuery, useInfiniteApiQuery } from "../lib/useApiQuery";
import { PopoverContent } from "@/components/ui/popover";
import type { FileRecord } from "@open-managed-agents/api-types";
import type { SessionRecord as Session } from "../types/session";

interface ListResponse {
  data: FileRecord[];
  has_more?: boolean;
  first_id?: string;
  last_id?: string;
}

const ALL_SCOPE = "";

export function FilesList() {
  const { api } = useApi();
  // Server-driven scope filter — `""` is the "All sessions" sentinel
  // (FacetedFilter requires a value, server treats undefined as no
  // filter), any other value is a real session id passed through as
  // `scope_id`.
  const [scopeId, setScopeId] = useState<string>(ALL_SCOPE);
  const [search, setSearch] = useState("");

  // Files endpoint follows the Anthropic Files API shape — `before_id`
  // for the cursor param and `last_id` (only when `has_more` is true) for
  // the next-page cursor — instead of OMA's standard `cursor` /
  // `next_cursor`. useInfiniteApiQuery accepts adapter overrides for both.
  const filesParams = useMemo(
    () => ({ scope_id: scopeId || undefined }),
    [scopeId],
  );
  const {
    items,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: refreshFiles,
  } = useInfiniteApiQuery<FileRecord>("/v1/files", {
    limit: 20,
    params: filesParams,
    cursorParam: "before_id",
    getNextCursor: (res) => {
      const r = res as ListResponse;
      return r.has_more ? r.data[r.data.length - 1]?.id : undefined;
    },
  });

  // Sessions for the Scope chip's option list. One-shot fetch of the
  // top 200 sessions visible to the user — same approach AgentsList
  // takes for its callable-agents dropdown. Sessions beyond the cap
  // aren't listed; users with a long tail still have the search box
  // inside the FacetedFilter (cmdk type-ahead) to find what they need
  // by id substring.
  const { data: sessionsRes } = useApiQuery<{ data: Session[] }>(
    "/v1/sessions",
    { limit: "200" },
  );
  const sessions = sessionsRes?.data ?? [];

  // Scope option list — "All" maps to no filter, every other option
  // carries the real session id and labels with the session title (or
  // the id when the title is blank).
  const scopeOptions = useMemo(
    () => [
      { value: ALL_SCOPE, label: "All sessions" },
      ...sessions.map((s) => ({
        value: s.id,
        label: s.title?.trim() ? `${s.title} (${s.id})` : s.id,
      })),
    ],
    [sessions],
  );

  // Pretty label for the active chip — falls back to the bare id when
  // the session isn't in our cached list (e.g. user landed via deep
  // link to a session beyond the 200-row cap).
  const scopeDisplay = useMemo(() => {
    if (!scopeId) return undefined;
    const hit = sessions.find((s) => s.id === scopeId);
    return hit?.title?.trim() ? hit.title : scopeId;
  }, [scopeId, sessions]);

  // Direct fetch for binary download — api() always parses JSON, and we need
  // the raw blob. Mirror its tenant-pin header so downloads honor the active
  // workspace, not the user's default tenant.
  const download = async (f: FileRecord) => {
    try {
      const activeTenant = getActiveTenantId();
      const res = await fetch(`/v1/files/${f.id}/content`, {
        credentials: "include",
        headers: activeTenant ? { "x-active-tenant": activeTenant } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = (body as { error?: string }).error || `HTTP ${res.status}`;
        toast.error(`Download failed: ${message}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(`Download failed: ${e instanceof Error ? e.message : "network error"}`);
    }
  };

  const remove = async (f: FileRecord) => {
    if (!confirm(`Delete "${f.filename}"? The R2 object and metadata both go. This cannot be undone.`)) return;
    try {
      await api(`/v1/files/${f.id}`, { method: "DELETE" });
      // Invalidate every /v1/files query (any scope filter) so the page
      // refetches — useInfiniteApiQuery exposes refresh() which bounces
      // back to page 0. Cheaper than maintaining a local optimistic
      // copy; the next refetch lands fresh server truth.
      refreshFiles();
    } catch {
      // toasted
    }
  };

  // Search is client-side over the loaded page — backend doesn't index
  // by filename and the upload API has no name filter. Operators who
  // need a file from the long tail filter by scope (server-side) first,
  // then narrow further by name within the page.
  const filtered = search
    ? items.filter((f) => f.filename.toLowerCase().includes(search.toLowerCase()))
    : items;

  const columns = useMemo<ColumnDef<FileRecord>[]>(
    () => [
      {
        id: "filename",
        accessorKey: "filename",
        header: "Filename",
        cell: ({ row }) => (
          <span title={row.original.filename} className="font-medium text-fg truncate inline-block max-w-[280px] align-bottom">
            {row.original.filename}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => (
          <span title={row.original.id} className="font-mono text-xs text-fg-muted">
            {row.original.id}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "media_type",
        accessorKey: "media_type",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">{row.original.media_type}</span>
        ),
      },
      {
        id: "size",
        accessorFn: (f) => f.size_bytes,
        header: "Size",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs tabular-nums">
            {formatBytes(row.original.size_bytes)}
          </span>
        ),
      },
      {
        id: "scope",
        accessorFn: (f) => f.scope_id ?? "",
        header: "Scope",
        cell: ({ row }) =>
          row.original.scope_id ? (
            <Link
              to={`/sessions/${row.original.scope_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-brand hover:underline text-xs font-mono"
            >
              {row.original.scope_id}
            </Link>
          ) : (
            <span className="text-fg-subtle text-xs">—</span>
          ),
      },
      {
        id: "created",
        accessorFn: (f) => f.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs whitespace-nowrap">
            {new Date(row.original.created_at).toLocaleString()}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const f = row.original;
          return (
            <RowActionsMenu
              label={`Actions for ${f.filename}`}
              actions={[
                ...(f.downloadable
                  ? [
                      {
                        label: "Download",
                        icon: <DownloadIcon className="size-4" />,
                        onSelect: () => {
                          void download(f);
                        },
                      },
                    ]
                  : []),
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: () => {
                    void remove(f);
                  },
                },
              ]}
            />
          );
        },
        enableHiding: false,
        size: 56,
      },
    ],
    // `download` / `remove` close over `api` and `refreshFiles`, both
    // stable identities (useCallback in api.ts + useApiQuery.ts) — so
    // the first-render closures stay correct for the lifetime of the
    // page, and an empty dep array is the right choice.
    [],
  );

  const filters = (
    <FilterChip
      label="Scope"
      active={scopeId !== ALL_SCOPE}
      display={scopeDisplay}
      onClear={() => setScopeId(ALL_SCOPE)}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-80 p-0"
      >
        <FacetedFilter
          options={scopeOptions}
          value={scopeId}
          onValueChange={(v) => setScopeId(v)}
          searchPlaceholder="Session id or title..."
        />
      </PopoverContent>
    </FilterChip>
  );

  return (
    <DataTable<FileRecord>
      searchPlaceholder="Filter loaded files by name…"
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={filtered}
      loading={loading}
      getRowId={(f) => f.id}
      hasMore={hasMore && !search}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={scopeId ? "No files in this scope" : "No files yet"}
      emptyKind="file"
      emptySubtitle={
        scopeId
          ? "Try clearing the scope filter, or check the session id."
          : <>Upload via <code className="text-xs">POST /v1/files</code> or the AMA SDK <code className="text-xs">client.beta.files.create()</code>.</>
      }
      columns={columns}
    />
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
