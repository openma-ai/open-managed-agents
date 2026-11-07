import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Select, SelectOption } from "../../components/Select";
import { useI18n } from "../../i18n";
import { useApi } from "../../lib/api";
import { useApiQuery, useQueryClient } from "../../lib/useApiQuery";
import { useManagedApi } from "../../lib/useManagedApi";
import {
  BENCHMARKS_BASE,
  benchmarkPath,
  describeError,
  invalidateBenchmarks,
  type BuiltinEvalBenchmark,
  type EvalBenchmark,
  type HarborCaseSource,
} from "./shared";

type SourceType = "git" | "builtin" | "registry" | "upload";

function splitNames(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

interface HarborSourceDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Pick a Harbor source (git / builtin / registry / uploaded archive) and
 *  import it as a new read-only benchmark (POST /benchmarks, revision 1). */
export function HarborSourceDialog({ open, onClose }: HarborSourceDialogProps) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();

  const [sourceType, setSourceType] = useState<SourceType>("builtin");
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitPath, setGitPath] = useState("");
  const [builtin, setBuiltin] = useState("");
  const [registryName, setRegistryName] = useState("");
  const [version, setVersion] = useState("");
  const [registryUrl, setRegistryUrl] = useState("");
  const [caseNames, setCaseNames] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "importing">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const { data: builtinsRes } = useApiQuery<{ data: BuiltinEvalBenchmark[] }>(
    open ? `${BENCHMARKS_BASE}/builtin` : null,
  );
  const builtins = builtinsRes?.data ?? [];

  const busy = phase !== "idle";
  const canSubmit =
    !busy &&
    (sourceType === "git"
      ? gitUrl.trim() !== ""
      : sourceType === "builtin"
      ? !!builtin
      : sourceType === "registry"
        ? registryName.trim() !== ""
        : !!file);

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      let source: HarborCaseSource;
      if (sourceType === "upload") {
        setPhase("uploading");
        const uploaded = await managedApi.files.upload({ file: file! });
        source = { type: "upload", file_id: uploaded.id };
      } else if (sourceType === "git") {
        source = {
          type: "git",
          url: gitUrl.trim(),
          ...(gitRef.trim() ? { ref: gitRef.trim() } : {}),
          ...(gitPath.trim() ? { path: gitPath.trim() } : {}),
        };
      } else if (sourceType === "registry") {
        source = {
          type: "registry",
          name: registryName.trim(),
          ...(version.trim() ? { version: version.trim() } : {}),
          ...(registryUrl.trim() ? { registry_url: registryUrl.trim() } : {}),
        };
      } else {
        source = { type: "builtin", name: builtin };
      }
      const names = sourceType === "upload" ? [] : splitNames(caseNames);
      const body = {
        kind: "harbor" as const,
        ...(name.trim() ? { name: name.trim() } : {}),
        source,
        ...(names.length > 0 ? { case_names: names } : {}),
      };
      setPhase("importing");
      const res = await api<EvalBenchmark>(BENCHMARKS_BASE, {
        method: "POST",
        body: JSON.stringify(body),
      });
      invalidateBenchmarks(queryClient);
      onClose();
      nav(benchmarkPath(res.id));
    } catch (e) {
      setError(describeError(t, e));
    } finally {
      setPhase("idle");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={m.importBenchmark}
      subtitle={m.importBenchmarkSubtitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {phase === "uploading" ? m.uploading : phase === "importing" ? m.importing : m.import}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={m.source}>
          <Select
            id="eval-harbor-source"
            value={sourceType}
            onValueChange={(v) => setSourceType(v as SourceType)}
          >
            <SelectOption value="builtin">{m.sourceBuiltin}</SelectOption>
            <SelectOption value="git">{m.sourceGit}</SelectOption>
            <SelectOption value="registry">{m.sourceRegistry}</SelectOption>
            <SelectOption value="upload">{m.sourceUpload}</SelectOption>
          </Select>
        </Field>

        {sourceType === "git" && (
          <>
            <Field label={m.gitUrl} hint={m.gitUrlHint}>
              <Input
                id="eval-harbor-git-url"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                autoComplete="off"
              />
            </Field>
            <Field label={m.gitRef} hint={m.gitRefHint}>
              <Input id="eval-harbor-git-ref" value={gitRef} onChange={(e) => setGitRef(e.target.value)} placeholder="HEAD" autoComplete="off" />
            </Field>
            <Field label={m.gitPath} hint={m.gitPathHint}>
              <Input id="eval-harbor-git-path" value={gitPath} onChange={(e) => setGitPath(e.target.value)} placeholder="tasks/" autoComplete="off" />
            </Field>
          </>
        )}

        {sourceType === "builtin" && (
          <Field
            label={m.builtinBenchmark}
            hint={builtins.length === 0 ? m.noBuiltins : builtins.find((b) => b.name === builtin)?.description}
          >
            <Select id="eval-harbor-builtin" value={builtin} onValueChange={setBuiltin} placeholder={m.selectBuiltin}>
              {builtins.map((b) => (
                <SelectOption key={b.name} value={b.name}>
                  {b.name} ({b.case_count})
                </SelectOption>
              ))}
            </Select>
          </Field>
        )}

        {sourceType === "registry" && (
          <>
            <Field label={m.registryName}>
              <Input
                id="eval-harbor-registry-name"
                value={registryName}
                onChange={(e) => setRegistryName(e.target.value)}
                placeholder="terminal-bench"
                autoComplete="off"
              />
            </Field>
            <Field label={m.registryVersion}>
              <Input id="eval-harbor-registry-version" value={version} onChange={(e) => setVersion(e.target.value)} autoComplete="off" />
            </Field>
            <Field label={m.registryUrl} hint={m.registryUrlHint}>
              <Input
                id="eval-harbor-registry-url"
                value={registryUrl}
                onChange={(e) => setRegistryUrl(e.target.value)}
                placeholder="https://"
                autoComplete="off"
              />
            </Field>
          </>
        )}

        {sourceType !== "upload" && (
          <Field label={m.caseNames} hint={m.caseNamesHint}>
            <Input
              id="eval-harbor-case-names"
              value={caseNames}
              onChange={(e) => setCaseNames(e.target.value)}
              placeholder="hello-world, fix-git"
              autoComplete="off"
            />
          </Field>
        )}

        {sourceType === "upload" && (
          <Field label={m.archive} hint={m.archiveHint}>
            <Input
              id="eval-harbor-archive"
              type="file"
              accept=".tar,.tar.gz,.tgz,application/x-tar,application/gzip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
        )}

        <Field label={m.benchmarkNameOptional} hint={m.benchmarkNameHint}>
          <Input id="eval-harbor-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>

        {error && (
          <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
