import { useMemo, useRef, useState } from "react";
import { TrashIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { RowActionsMenu } from "../components/RowActionsMenu";

/* ---------- types ---------- */

interface Skill {
  id: string;
  display_title: string;
  name: string;
  description: string;
  source: "anthropic" | "custom";
  latest_version: number;
  created_at: string;
}

interface SkillFile {
  filename: string;
  content: string;
  encoding?: "utf8" | "base64";
}

interface VersionSummary {
  version: number;
  created_at: string;
}

interface VersionDetail {
  version: number;
  created_at: string;
  files: SkillFile[];
}

type SourceValue = "any" | "anthropic" | "custom";

const SOURCE_OPTIONS: { value: SourceValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "Custom" },
];

/* ---------- constants ---------- */

// Mirrors the default UPLOAD_MAX_BYTES on the server (apps/main/src/quotas.ts).
// Self-hosters who raised the server limit will lose this client-side
// pre-rejection but the server will still enforce; that's an acceptable
// degradation for an unusual config.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isZipFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}

/* ---------- component ---------- */

export function SkillsList() {
  const { api } = useApi();

  /* Server-driven filter state. `source` flows into skillsParams below
   * → useApiQuery reruns when params change → list reflects exactly
   * what the server returned (no client-side split on s.source). */
  const [source, setSource] = useState<SourceValue>("any");
  const skillsParams = useMemo(
    () => (source !== "any" ? { source } : {}),
    [source],
  );

  /* list state — TQ owns the fetch lifecycle. `load()` becomes
   * `refetch`, which kicks off a background refetch that leaves
   * the prior items on screen until the new payload lands. */
  const {
    data: skillsRes,
    isLoading: loading,
    refetch: refetchSkills,
  } = useApiQuery<{ data: Skill[] }>("/v1/skills", skillsParams);
  const skills = skillsRes?.data ?? [];
  const load = () => {
    void refetchSkills();
  };

  /* create dialog */
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createZip, setCreateZip] = useState<File | null>(null);
  const [createUploading, setCreateUploading] = useState(false);
  const [createDragOver, setCreateDragOver] = useState(false);
  const [createError, setCreateError] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  /* detail dialog */
  const [detail, setDetail] = useState<Skill | null>(null);
  const [detailFiles, setDetailFiles] = useState<SkillFile[]>([]);
  const [detailVersions, setDetailVersions] = useState<VersionSummary[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  /* new version sub-form inside detail */
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [nvZip, setNvZip] = useState<File | null>(null);
  const [nvUploading, setNvUploading] = useState(false);
  const [nvDragOver, setNvDragOver] = useState(false);
  const [nvError, setNvError] = useState("");
  const nvInputRef = useRef<HTMLInputElement>(null);

  /* ---- loaders ---- */

  /* ---- create ---- */

  const resetCreate = () => {
    setCreateTitle("");
    setCreateZip(null);
    setCreateError("");
    setCreateDragOver(false);
    if (createInputRef.current) createInputRef.current.value = "";
  };

  // Validate file synchronously and set state. Returns true on success
  // so callers can know whether to clear the surrounding drop-zone state.
  const acceptCreateZip = (file: File): boolean => {
    if (!isZipFile(file)) {
      setCreateError(`"${file.name}" is not a .zip file`);
      return false;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setCreateError(
        `Zip is ${formatBytes(file.size)}, exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit`,
      );
      return false;
    }
    setCreateError("");
    setCreateZip(file);
    return true;
  };

  const doCreate = async () => {
    if (!createZip) return;
    setCreateError("");
    setCreateUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", createZip);
      // Empty string here would override the server-side fallback to the
      // SKILL.md frontmatter name; only send when the user actually typed
      // something.
      if (createTitle.trim()) fd.append("display_title", createTitle.trim());
      await api("/v1/skills/upload", { method: "POST", body: fd });
      setShowCreate(false);
      resetCreate();
      load();
    } catch (e: any) {
      setCreateError(e?.message || "Upload failed");
    } finally {
      setCreateUploading(false);
    }
  };

  /* ---- detail ---- */

  const openDetail = async (skill: Skill) => {
    setDetail(skill);
    setDetailLoading(true);
    setShowNewVersion(false);
    setNvError("");
    setNvZip(null);
    try {
      const [versionDetail, versionsRes] = await Promise.all([
        api<VersionDetail>(
          `/v1/skills/${skill.id}/versions/${skill.latest_version}`
        ),
        api<{ data: VersionSummary[] }>(`/v1/skills/${skill.id}/versions`),
      ]);
      setDetailFiles(versionDetail.files || []);
      setDetailVersions(versionsRes.data || []);
    } catch {
      setDetailFiles([]);
      setDetailVersions([]);
    }
    setDetailLoading(false);
  };

  const closeDetail = () => {
    setDetail(null);
    setDetailFiles([]);
    setDetailVersions([]);
    setShowNewVersion(false);
    setNvZip(null);
    setNvError("");
  };

  /* ---- new version ---- */

  const startNewVersion = () => {
    setNvError("");
    setNvZip(null);
    setNvDragOver(false);
    if (nvInputRef.current) nvInputRef.current.value = "";
    setShowNewVersion(true);
  };

  const acceptNvZip = (file: File): boolean => {
    if (!isZipFile(file)) {
      setNvError(`"${file.name}" is not a .zip file`);
      return false;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setNvError(
        `Zip is ${formatBytes(file.size)}, exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit`,
      );
      return false;
    }
    setNvError("");
    setNvZip(file);
    return true;
  };

  const doNewVersion = async () => {
    if (!detail || !nvZip) return;
    setNvError("");
    setNvUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", nvZip);
      await api(`/v1/skills/${detail.id}/versions/upload`, {
        method: "POST",
        body: fd,
      });
      setShowNewVersion(false);
      setNvZip(null);
      /* refresh both the list and this detail */
      load();
      const refreshed = await api<Skill>(`/v1/skills/${detail.id}`);
      openDetail(refreshed);
    } catch (e: any) {
      setNvError(e?.message || "Upload failed");
    } finally {
      setNvUploading(false);
    }
  };

  /* ---- delete ---- */

  const deleteSkill = async () => {
    if (!detail) return;
    if (!confirm("Delete this skill? This cannot be undone.")) return;
    try {
      await api(`/v1/skills/${detail.id}`, { method: "DELETE" });
      closeDetail();
      load();
    } catch {}
  };

  // Row-level delete invoked from the per-row actions menu. Separate from
  // the modal's deleteSkill because the row's confirm copy uses the
  // skill's own title and there's no detail dialog to close after.
  const deleteSkillById = async (skill: Skill) => {
    const name = skill.display_title || skill.name;
    if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
    try {
      await api(`/v1/skills/${skill.id}`, { method: "DELETE" });
      load();
    } catch {}
  };

  /* ---- helpers ---- */

  const inputCls =
    "w-full border border-border rounded-lg px-3 py-2 min-h-11 sm:min-h-0 text-sm outline-none focus:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] bg-bg text-fg";

  // TanStack column defs. Single table for both Anthropic built-in + custom
  // skills; the Source column lets the user tell them apart at a glance.
  // No click sort / no per-column filter — Source filter chip drives the
  // server `source` param instead.
  const columns = useMemo<ColumnDef<Skill>[]>(
    () => [
      {
        id: "name",
        accessorKey: "display_title",
        header: "Name",
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-medium text-fg truncate">
              {row.original.display_title || row.original.name}
            </div>
            <div className="text-xs text-fg-subtle font-mono truncate">
              {row.original.source === "anthropic" ? row.original.name : row.original.id}
            </div>
          </div>
        ),
        enableHiding: false,
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="text-fg-muted">{row.original.description}</span>
        ),
      },
      {
        id: "source",
        accessorKey: "source",
        header: "Source",
        cell: ({ row }) =>
          row.original.source === "anthropic" ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning-subtle text-warning">
              built-in
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-bg-surface text-fg-muted">
              custom
            </span>
          ),
      },
      {
        id: "version",
        accessorFn: (s) => s.latest_version,
        header: "Version",
        cell: ({ row }) => (
          <span className="text-fg-muted">v{row.original.latest_version}</span>
        ),
      },
      {
        id: "created",
        accessorFn: (s) => s.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const s = row.original;
          // Anthropic built-in skills aren't user-editable; render the
          // item as disabled so the menu layout stays uniform across
          // rows but the user can't trigger a 4xx.
          const isBuiltIn = s.source === "anthropic";
          return (
            <RowActionsMenu
              label={`Actions for ${s.display_title || s.name}`}
              actions={[
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  disabled: isBuiltIn,
                  onSelect: () => {
                    void deleteSkillById(s);
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
    [],
  );

  // Active-filter chip displays — kept undefined when matching the default
  // so the chip reads "Source ▾" rather than "Source: All ▾". The clear-X
  // only renders when the chip is in non-default state.
  const sourceDisplay =
    source === "any" ? undefined : SOURCE_OPTIONS.find((o) => o.value === source)?.label;

  const filters = (
    <FilterChip
      label="Source"
      active={source !== "any"}
      display={sourceDisplay}
      onClear={() => setSource("any")}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-48 p-0"
      >
        <FacetedFilter
          options={SOURCE_OPTIONS}
          value={source}
          onValueChange={(v) => setSource(v as SourceValue)}
          searchPlaceholder="Source..."
        />
      </PopoverContent>
    </FilterChip>
  );

  // Built-in (anthropic) skills aren't user-editable; click on those rows
  // is a no-op so we don't open a half-empty detail dialog that would 404
  // on its version fetches.
  const handleRowClick = (s: Skill) => {
    if (s.source === "custom") openDetail(s);
  };

  /* ---- render ---- */

  return (
    <DataTable<Skill>
      subtitle="Manage pre-built and custom skills for your agents."
      createLabel="+ New skill"
      onCreate={() => setShowCreate(true)}
      filters={filters}
      data={skills}
      loading={loading}
      getRowId={(s) => s.id}
      onRowClick={handleRowClick}
      columns={columns}
      emptyTitle="No skills yet"
      emptyKind="skill"
      emptySubtitle="Create a skill to give your agents domain expertise."
      emptyAction={<Button onClick={() => setShowCreate(true)}>+ New skill</Button>}
    >
      {/* ===== Create Dialog ===== */}
      <Modal
        open={showCreate}
        onClose={() => {
          if (createUploading) return;
          setShowCreate(false);
          resetCreate();
        }}
        title="Upload Custom Skill"
        subtitle="Upload an Anthropic-style skill folder packaged as a .zip."
        maxWidth="max-w-xl"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={createUploading}
              onClick={() => {
                setShowCreate(false);
                resetCreate();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={doCreate}
              disabled={!createZip || createUploading}
              loading={createUploading}
              loadingLabel="Uploading..."
            >
              Upload
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {createError}
            </div>
          )}

          {/* Drop zone */}
          <DropZone
            file={createZip}
            dragOver={createDragOver}
            onDragOver={(over) => setCreateDragOver(over)}
            onFile={(f) => acceptCreateZip(f)}
            onClear={() => {
              setCreateZip(null);
              if (createInputRef.current) createInputRef.current.value = "";
            }}
            inputRef={createInputRef}
            disabled={createUploading}
          />

          {/* Display Title (optional override) */}
          <div>
            <label className="text-sm text-fg-muted block mb-1">
              Display Title{" "}
              <span className="text-fg-subtle">
                (optional — falls back to SKILL.md <code>name</code>)
              </span>
            </label>
            <input
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              className={inputCls}
              placeholder="Leave blank to use the skill's own name"
              disabled={createUploading}
            />
          </div>

          <p className="text-xs text-fg-subtle">
            The zip must contain <code>SKILL.md</code> at the root, or one
            top-level folder containing it (the common case when you
            <code> zip -r my-skill.zip my-skill</code>).
          </p>
        </div>
      </Modal>

      {/* ===== Detail Dialog ===== */}
      <Modal
        open={!!detail}
        onClose={closeDetail}
        title={detail?.display_title || detail?.name || ""}
        subtitle={detail ? `${detail.id} · v${detail.latest_version}` : ""}
        maxWidth="max-w-2xl"
        footer={
          <Button variant="ghost" onClick={closeDetail}>
            Close
          </Button>
        }
      >
        {detailLoading ? (
          <div className="text-fg-subtle text-sm py-8 text-center">
            Loading...
          </div>
        ) : detail ? (
          <div className="space-y-5">
            {/* Actions */}
            <div className="flex justify-end">
              <Button variant="destructive" size="sm" onClick={deleteSkill}>
                Delete
              </Button>
            </div>

            {/* Metadata */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">
                  Display Title
                </label>
                <p className="text-sm font-medium">
                  {detail.display_title}
                </p>
              </div>
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">
                  Name
                </label>
                <p className="text-sm font-mono">
                  {detail.name}
                </p>
              </div>
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">
                  Description
                </label>
                <p className="text-sm text-fg-muted">
                  {detail.description}
                </p>
              </div>
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">
                  Created
                </label>
                <p className="text-sm text-fg-muted">
                  {new Date(detail.created_at).toLocaleString()}
                </p>
              </div>
            </div>

            {/* Usage hint */}
            <div>
              <label className="text-xs text-fg-muted block mb-1">
                Usage in Agent Config
              </label>
              <pre className="bg-bg-surface border border-border rounded-lg p-3 text-xs font-mono text-fg-muted">
{`"skills": [{ "type": "custom", "skill_id": "${detail.id}", "version": "latest" }]`}
              </pre>
            </div>

            {/* Files */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-fg-muted">
                  Files (v{detail.latest_version})
                </label>
                <button
                  onClick={startNewVersion}
                  className="inline-flex items-center min-h-11 sm:min-h-0 px-2 text-xs text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                >
                  + New version
                </button>
              </div>
              {detailFiles.length === 0 ? (
                <p className="text-xs text-fg-subtle">
                  No files in this version.
                </p>
              ) : (
                <div className="space-y-2">
                  {detailFiles.map((f, i) => (
                    <div
                      key={i}
                      className="border border-border rounded-lg overflow-hidden"
                    >
                      <div className="bg-bg-surface px-3 py-1.5 border-b border-border text-xs font-mono text-fg-muted flex items-center justify-between">
                        <span className="truncate">{f.filename}</span>
                        {f.encoding === "base64" && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-fg-subtle">
                            binary
                          </span>
                        )}
                      </div>
                      {f.encoding === "base64" ? (
                        <p className="px-3 py-2 text-xs italic text-fg-subtle">
                          Binary file — not previewed.
                        </p>
                      ) : (
                        <pre className="px-3 py-2 text-xs font-mono text-fg-muted whitespace-pre-wrap max-h-60 overflow-y-auto leading-relaxed">
                          {f.content}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* New Version sub-form */}
            {showNewVersion && (
              <div className="border border-border-strong rounded-lg p-4 bg-bg-surface/50 space-y-3">
                <h3 className="text-sm font-medium text-fg">
                  Upload New Version
                </h3>
                {nvError && (
                  <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
                    {nvError}
                  </div>
                )}
                <DropZone
                  file={nvZip}
                  dragOver={nvDragOver}
                  onDragOver={(over) => setNvDragOver(over)}
                  onFile={(f) => acceptNvZip(f)}
                  onClear={() => {
                    setNvZip(null);
                    if (nvInputRef.current) nvInputRef.current.value = "";
                  }}
                  inputRef={nvInputRef}
                  disabled={nvUploading}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={nvUploading}
                    onClick={() => {
                      setShowNewVersion(false);
                      setNvZip(null);
                      setNvError("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={doNewVersion}
                    disabled={!nvZip || nvUploading}
                    loading={nvUploading}
                    loadingLabel="Uploading..."
                  >
                    Publish Version
                  </Button>
                </div>
              </div>
            )}

            {/* Versions list */}
            <div>
              <label className="text-xs text-fg-muted block mb-2">
                Version History
              </label>
              {detailVersions.length === 0 ? (
                <p className="text-xs text-fg-subtle">
                  No version history available.
                </p>
              ) : (
                <div className="border border-border rounded-lg overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                        <th className="text-left px-4 py-2">Version</th>
                        <th className="text-left px-4 py-2">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailVersions.map((v) => (
                        <tr
                          key={v.version}
                          className="border-t border-border"
                        >
                          <td className="px-4 py-2 font-mono text-xs">
                            v{v.version}
                            {v.version === detail.latest_version && (
                              <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-success-subtle text-success">
                                latest
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-fg-muted text-xs">
                            {new Date(v.created_at).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </DataTable>
  );
}

/* ---------- DropZone ---------- */

interface DropZoneProps {
  file: File | null;
  dragOver: boolean;
  onDragOver: (over: boolean) => void;
  onFile: (file: File) => boolean;
  onClear: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}

function DropZone({
  file,
  dragOver,
  onDragOver,
  onFile,
  onClear,
  inputRef,
  disabled,
}: DropZoneProps) {
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    onDragOver(false);
    if (disabled) return;
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) onDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        onDragOver(false);
      }}
      onDrop={handleDrop}
      className={[
        "border-2 border-dashed rounded-lg px-4 py-6 text-center transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]",
        dragOver
          ? "border-brand bg-brand/5"
          : "border-border bg-bg-surface/30",
        disabled ? "opacity-60 pointer-events-none" : "",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      {file ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-left">
            <div className="text-sm font-medium text-fg truncate">{file.name}</div>
            <div className="text-xs text-fg-subtle">{formatBytes(file.size)}</div>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => inputRef.current?.click()}
            >
              Replace
            </Button>
            <Button variant="ghost" size="sm" onClick={onClear}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-sm text-fg-muted">
            Drag &amp; drop a <code>.zip</code>, or
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => inputRef.current?.click()}
          >
            Choose file
          </Button>
        </div>
      )}
    </div>
  );
}
