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
  benchmarkApiPath,
  benchmarkPath,
  describeError,
  invalidateBenchmarks,
  type BuiltinEvalBenchmark,
  type EvalBenchmark,
  type HarborCaseSource,
} from "./shared";

type SourceType = "builtin" | "registry" | "upload";

function splitNames(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

interface HarborSourceDialogProps {
  open: boolean;
  onClose: () => void;
  /** Set to add cases to this harbor benchmark; omitted to import a new
   *  benchmark (POST /benchmarks). */
  benchmarkId?: string;
}

/** Pick a Harbor source (builtin / registry / uploaded archive) and either
 *  import it as a new benchmark or add its tasks as cases. */
export function HarborSourceDialog({ open, onClose, benchmarkId }: HarborSourceDialogProps) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const adding = benchmarkId !== undefined;

  const [sourceType, setSourceType] = useState<SourceType>(adding ? "upload" : "builtin");
  const [name, setName] = useState("");
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
    (sourceType === "builtin"
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
        ...(!adding ? { kind: "harbor" as const } : {}),
        ...(!adding && name.trim() ? { name: name.trim() } : {}),
        source,
        ...(names.length > 0 ? { case_names: names } : {}),
      };
      setPhase("importing");
      const res = await api<EvalBenchmark>(adding ? `${benchmarkApiPath(benchmarkId)}/cases` : BENCHMARKS_BASE, {
        method: "POST",
        body: JSON.stringify(body),
      });
      invalidateBenchmarks(queryClient);
      onClose();
      if (!adding) nav(benchmarkPath(res.id));
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
      title={adding ? m.addCase : m.importBenchmark}
      subtitle={adding ? m.addHarborCasesSubtitle : m.importBenchmarkSubtitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {phase === "uploading"
              ? m.uploading
              : phase === "importing"
                ? adding ? m.adding : m.importing
                : adding ? m.add : m.import}
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
            <SelectOption value="upload">{m.sourceUpload}</SelectOption>
            <SelectOption value="builtin">{m.sourceBuiltin}</SelectOption>
            <SelectOption value="registry">{m.sourceRegistry}</SelectOption>
          </Select>
        </Field>

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

        {!adding && (
          <Field label={m.benchmarkNameOptional} hint={m.benchmarkNameHint}>
            <Input id="eval-harbor-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </Field>
        )}

        {error && (
          <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
