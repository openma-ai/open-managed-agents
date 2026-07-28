import { useEffect, useMemo, useState } from "react";
import { XCircleIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { RowActionsMenu } from "../components/RowActionsMenu";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
}

export function ApiKeysList() {
  const { api } = useApi();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      setKeys((await api<{ data: ApiKey[] }>("/v1/api_keys")).data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // useAsyncAction guards re-entry: a fast double-click on the Create
  // button used to fire two POSTs and produce two records 0.5-1s apart.
  // The hook + Button loading prop handle this universally now.
  const create = useAsyncAction(async () => {
    setError("");
    try {
      const result = await api<{ key: string }>("/v1/api_keys", {
        method: "POST",
        body: JSON.stringify({ name: name || "Untitled key" }),
      });
      setCreatedKey(result.key);
      setName("");
      load();
    } catch (e: any) {
      setError(e?.message || "Failed to create key");
    }
  });

  const remove = async (id: string) => {
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    try {
      await api(`/v1/api_keys/${id}`, { method: "DELETE" });
      load();
    } catch {}
  };

  const closeDialog = () => {
    setShowCreate(false);
    setCreatedKey("");
    setName("");
    setError("");
  };

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  // TanStack column defs. API keys come back as a small flat list (no
  // pagination, no server filters) so there's no per-column sort or
  // filter UI to wire up. `name` and `actions` opt out of the Columns
  // hide menu — without the name you can't tell keys apart, and without
  // Revoke the table becomes read-only.
  const columns = useMemo<ColumnDef<ApiKey>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <>
            <div className="font-medium text-fg">{row.original.name}</div>
            <div className="text-xs text-fg-subtle font-mono">{row.original.id}</div>
          </>
        ),
        enableHiding: false,
      },
      {
        id: "key",
        accessorKey: "prefix",
        header: "Key",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-muted">{row.original.prefix}...</span>
        ),
      },
      {
        id: "created",
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <RowActionsMenu
            label={`Actions for ${row.original.name}`}
            actions={[
              {
                label: "Revoke",
                icon: <XCircleIcon className="size-4" />,
                destructive: true,
                onSelect: () => {
                  void remove(row.original.id);
                },
              },
            ]}
          />
        ),
        enableHiding: false,
        size: 56,
      },
    ],
    [],
  );

  return (
    <DataTable<ApiKey>
      createLabel="+ New API key"
      onCreate={() => setShowCreate(true)}
      data={keys}
      loading={loading}
      getRowId={(k) => k.id}
      emptyTitle="No API keys yet"
      emptyKind="api_key"
      emptySubtitle="Create an API key to access the platform from CLI or SDK."
      columns={columns}
    >
      <Modal
        open={showCreate}
        onClose={closeDialog}
        title={createdKey ? "API Key Created" : "New API Key"}
        footer={
          createdKey ? (
            <Button onClick={closeDialog}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeDialog} disabled={create.loading}>
                Cancel
              </Button>
              <Button onClick={create.run} loading={create.loading} loadingLabel="Creating…">
                Create
              </Button>
            </>
          )
        }
      >
        {createdKey ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-muted">
              Copy this key now. You won't be able to see it again.
            </p>
            <div className="bg-bg-surface border border-border rounded-lg p-3">
              <code className="text-sm font-mono text-fg break-all select-all">
                {createdKey}
              </code>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(createdKey)}
              className="inline-flex items-center min-h-11 sm:min-h-0 text-sm text-brand hover:underline"
            >
              Copy to clipboard
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {error && (
              <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="api-key-name" className="text-sm text-fg-muted block mb-1">
                Name (optional)
              </label>
              <input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
                placeholder="e.g. CLI key, CI/CD"
              />
            </div>
          </div>
        )}
      </Modal>
    </DataTable>
  );
}
