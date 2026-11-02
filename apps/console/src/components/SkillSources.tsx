// Skill sources: install skills from any site that publishes the Agent Skills
// discovery index (the `npx skills add <url>` protocol) and keep them updated.
// Backed by /v1/oma/skill-sources on the self-hosted control plane; when the
// route is absent the console hides these controls.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useScrollFade } from "@/hooks/useScrollFade";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getActiveTenantId, useApi } from "../lib/api";

export const SKILL_SOURCES_API = "/v1/oma/skill-sources";

export interface SkillSourceLock {
  skill_id: string;
  source_url: string;
  name: string;
  digest: string;
  version: string;
  installed_at: string;
  updated_at: string;
}

interface DiscoveredSkill {
  name: string;
  description: string;
  digest: string | null;
  installed_skill_id: string | null;
}

type InstallResult =
  | { name: string; status: "installed" | "updated" | "unchanged"; skill_id: string; version: string }
  | { name: string; status: "error"; error: string; skill_id?: string };

interface UpdateCheck {
  sources: { url: string; status: "ok" | "error"; error?: string; new_skills: { name: string; description: string }[] }[];
  skills: {
    skill_id: string;
    name: string;
    source_url: string;
    status: "current" | "update_available" | "removed" | "error";
    error?: string;
  }[];
}

export function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Tracking records for installed source skills, keyed by skill id.
 * `available` is null while loading and false when the deployment has no
 * skill-source routes. The probe uses fetch directly so a missing route does
 * not raise the global error toast.
 */
export function useSkillSources() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [locks, setLocks] = useState<Map<string, SkillSourceLock>>(new Map());

  const refresh = useCallback(async () => {
    const tenant = getActiveTenantId();
    try {
      const res = await fetch(`${SKILL_SOURCES_API}/installed`, {
        credentials: "include",
        headers: tenant ? { "x-active-tenant": tenant } : {},
      });
      if (!res.ok) {
        setAvailable(false);
        return;
      }
      const body = (await res.json()) as { data?: SkillSourceLock[] };
      setLocks(new Map((body.data ?? []).map((l) => [l.skill_id, l])));
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { available: available === true, loading: available === null, locks, refresh };
}

const STATUS_TEXT: Record<InstallResult["status"], string> = {
  installed: "Installed",
  updated: "Updated",
  unchanged: "Already up to date",
  error: "Failed",
};

function ResultList({ results }: { results: InstallResult[] }) {
  return (
    <ul className="divide-y divide-border border border-border rounded-lg" aria-label="Results">
      {results.map((r) => (
        <li key={r.name} className="px-3 py-2 text-sm flex items-start justify-between gap-3">
          <span className="font-mono">{r.name}</span>
          <span className={r.status === "error" ? "text-danger text-right" : "text-fg-muted text-right"}>
            {STATUS_TEXT[r.status]}
            {r.status === "error" && <span className="block text-xs">{r.error}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const errorBox = "text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2";

/* ---------- install from URL ---------- */

export function InstallFromUrlModal({
  open,
  onClose,
  onInstalled,
  initialUrl = "",
}: {
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
  initialUrl?: string;
}) {
  const { api } = useApi();
  const listFade = useScrollFade<HTMLUListElement>();
  const [url, setUrl] = useState(initialUrl);
  const [found, setFound] = useState<{ url: string; skills: DiscoveredSkill[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"discover" | "install" | null>(null);
  const [error, setError] = useState("");
  const [results, setResults] = useState<InstallResult[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl);
    setFound(null);
    setSelected(new Set());
    setError("");
    setResults(null);
  }, [open, initialUrl]);

  const discover = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!url.trim()) return;
    setBusy("discover");
    setError("");
    setResults(null);
    try {
      const body = await api<{ url: string; data: DiscoveredSkill[] }>(`${SKILL_SOURCES_API}/discover`, {
        method: "POST",
        body: JSON.stringify({ url: url.trim() }),
      });
      setFound({ url: body.url, skills: body.data });
      setSelected(new Set(body.data.filter((s) => !s.installed_skill_id).map((s) => s.name)));
    } catch (err) {
      setFound(null);
      setError(err instanceof Error ? err.message : "Could not read that source");
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!found || selected.size === 0) return;
    setBusy("install");
    setError("");
    try {
      const body = await api<{ data: InstallResult[] }>(`${SKILL_SOURCES_API}/install`, {
        method: "POST",
        body: JSON.stringify({ url: found.url, skills: [...selected] }),
      });
      setResults(body.data);
      onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (name: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const allSelected = !!found && found.skills.length > 0 && selected.size === found.skills.length;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      title="Install skills from a URL"
      subtitle="Any site that publishes an Agent Skills index, the same URL you would pass to npx skills add."
      maxWidth="max-w-xl"
      footer={
        results ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={!!busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={install}
              disabled={!found || selected.size === 0 || !!busy}
              loading={busy === "install"}
              loadingLabel="Installing..."
            >
              {selected.size > 0 ? `Install ${selected.size}` : "Install"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <form onSubmit={discover} className="flex gap-2 items-end">
          <div className="flex-1">
            <Label htmlFor="skill-source-url" className="text-sm text-fg-muted block mb-1">
              Source URL
            </Label>
            <Input
              id="skill-source-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://skills.example.com"
              disabled={!!busy || !!results}
              autoFocus
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={!url.trim() || !!busy || !!results}
            loading={busy === "discover"}
            loadingLabel="Finding..."
          >
            Find skills
          </Button>
        </form>

        {error && <div className={errorBox}>{error}</div>}

        {results ? (
          <ResultList results={results} />
        ) : found ? (
          found.skills.length === 0 ? (
            <p className="text-sm text-fg-subtle">This source lists no skills.</p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-fg-muted">
                <span>
                  {found.skills.length} skill{found.skills.length === 1 ? "" : "s"} at {sourceLabel(found.url)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setSelected(allSelected ? new Set() : new Set(found.skills.map((s) => s.name)))}
                >
                  {allSelected ? "Clear selection" : "Select all"}
                </Button>
              </div>
              <ul ref={listFade.ref} className={`console-scroll-fade ${listFade.className} border border-border rounded-lg divide-y divide-border max-h-80 overflow-y-auto`}>
                {found.skills.map((s) => (
                  <li key={s.name}>
                    <Label className="flex items-start gap-3 px-3 py-2 cursor-pointer font-normal hover:bg-bg-surface/60">
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.has(s.name)}
                        onCheckedChange={(v) => toggle(s.name, v === true)}
                        aria-label={s.name}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-sm text-fg">{s.name}</span>
                          {s.installed_skill_id && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs bg-bg-surface text-fg-muted">
                              installed
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-fg-muted">{s.description}</span>
                      </span>
                    </Label>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-fg-subtle">
                Reinstalling an installed skill adds a new version only when its contents changed.
              </p>
            </div>
          )
        ) : null}
      </div>
    </Modal>
  );
}

/* ---------- check for updates ---------- */

const CHECK_TEXT: Record<UpdateCheck["skills"][number]["status"], string> = {
  current: "Up to date",
  update_available: "Update available",
  removed: "No longer at source",
  error: "Check failed",
};

export function SkillUpdatesModal({
  open,
  onClose,
  onUpdated,
  onInstallNew,
  skillIds,
}: {
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
  /** Opens the install dialog for a source that lists skills not yet installed. */
  onInstallNew?: (url: string) => void;
  /** Restrict to these skills; all tracked skills when omitted. */
  skillIds?: string[];
}) {
  const { api } = useApi();
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [results, setResults] = useState<InstallResult[] | null>(null);
  const idsKey = skillIds?.join(",") ?? "";

  const runCheck = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      setCheck(
        await api<UpdateCheck>(`${SKILL_SOURCES_API}/check-updates`, {
          method: "POST",
          body: JSON.stringify(idsKey ? { skill_ids: idsKey.split(",") } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check for updates");
    } finally {
      setChecking(false);
    }
  }, [api, idsKey]);

  useEffect(() => {
    if (!open) return;
    setCheck(null);
    setResults(null);
    void runCheck();
  }, [open, runCheck]);

  const pending = useMemo(
    () => (check?.skills ?? []).filter((s) => s.status === "update_available").map((s) => s.skill_id),
    [check],
  );

  const update = async (ids: string[]) => {
    if (ids.length === 0) return;
    setUpdating(ids);
    setError("");
    try {
      const body = await api<{ data: InstallResult[] }>(`${SKILL_SOURCES_API}/update`, {
        method: "POST",
        body: JSON.stringify({ skill_ids: ids }),
      });
      setResults(body.data);
      onUpdated();
      await runCheck();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setUpdating(null);
    }
  };

  const busy = checking || updating !== null;
  const newSkills = (check?.sources ?? []).filter((s) => s.new_skills.length > 0);

  return (
    <Modal
      open={open}
      onClose={() => {
        if (updating) return;
        onClose();
      }}
      title="Skill updates"
      subtitle="Compares installed skills with their sources, like npx skills update."
      maxWidth="max-w-xl"
      footer={
        <>
          <Button variant="ghost" disabled={updating !== null} onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => void update(pending)}
            disabled={pending.length === 0 || busy}
            loading={updating !== null && updating.length > 1}
            loadingLabel="Updating..."
          >
            {pending.length > 0 ? `Update all (${pending.length})` : "Update all"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <div className={errorBox}>{error}</div>}
        {results && results.some((r) => r.status !== "unchanged") && <ResultList results={results} />}
        {!check && checking ? (
          <div className="text-fg-subtle text-sm py-6 text-center">Checking sources...</div>
        ) : check && check.skills.length === 0 ? (
          <p className="text-sm text-fg-subtle">No skills installed from a URL yet.</p>
        ) : check ? (
          <ul className="border border-border rounded-lg divide-y divide-border" aria-label="Installed from sources">
            {check.skills.map((s) => (
              <li key={s.skill_id} className="px-3 py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm text-fg truncate">{s.name}</div>
                  <div className="text-xs text-fg-subtle truncate" title={s.source_url}>
                    {sourceLabel(s.source_url)}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={
                      s.status === "update_available"
                        ? "text-xs font-medium text-warning"
                        : s.status === "error" || s.status === "removed"
                          ? "text-xs text-danger"
                          : "text-xs text-fg-muted"
                    }
                    title={s.error}
                  >
                    {CHECK_TEXT[s.status]}
                  </span>
                  {s.status === "update_available" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      loading={updating?.length === 1 && updating[0] === s.skill_id}
                      loadingLabel="Updating..."
                      onClick={() => void update([s.skill_id])}
                      aria-label={`Update ${s.name}`}
                    >
                      Update
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {newSkills.map((source) => (
          <div key={source.url} className="text-xs text-fg-muted flex items-center justify-between gap-3">
            <span>
              {source.new_skills.length} more skill{source.new_skills.length === 1 ? "" : "s"} available from{" "}
              {sourceLabel(source.url)}: {source.new_skills.map((s) => s.name).join(", ")}
            </span>
            {onInstallNew && (
              <Button size="sm" variant="ghost" onClick={() => onInstallNew(source.url)}>
                Install...
              </Button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
