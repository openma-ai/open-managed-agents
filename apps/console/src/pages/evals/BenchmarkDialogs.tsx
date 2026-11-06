import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Select, SelectOption } from "../../components/Select";
import { useI18n } from "../../i18n";
import { useApi } from "../../lib/api";
import { useQueryClient } from "../../lib/useApiQuery";
import { useManagedApi } from "../../lib/useManagedApi";
import {
  BENCHMARKS_BASE,
  benchmarkApiPath,
  benchmarkPath,
  caseApiPath,
  describeError,
  invalidateBenchmarks,
  type EvalBenchmark,
  type EvalBenchmarkKind,
} from "./shared";

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
      {error}
    </div>
  );
}

/** New benchmark: a messages benchmark or an empty harbor benchmark. */
export function CreateBenchmarkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<EvalBenchmarkKind>("messages");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setKind("messages");
    setError(null);
  }, [open]);

  const canSubmit = name.trim() !== "" && !busy;
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<EvalBenchmark>(BENCHMARKS_BASE, {
        method: "POST",
        body: JSON.stringify({ kind, name: name.trim() }),
      });
      invalidateBenchmarks(queryClient);
      onClose();
      nav(benchmarkPath(created.id));
    } catch (e) {
      setError(describeError(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={m.newBenchmark}
      subtitle={m.newBenchmarkSubtitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={submit} disabled={!canSubmit}>{busy ? m.creating : m.create}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={m.benchmarkName}>
          <Input id="eval-benchmark-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Field label={m.kind} hint={kind === "harbor" ? m.kindHarborHint : m.kindMessagesHint}>
          <Select id="eval-benchmark-kind" value={kind} onValueChange={(v) => setKind(v as EvalBenchmarkKind)}>
            <SelectOption value="messages">{m.kindMessages}</SelectOption>
            <SelectOption value="harbor">{m.kindHarbor}</SelectOption>
          </Select>
        </Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

/** PATCH a benchmark's name. */
export function RenameBenchmarkDialog({
  open,
  onClose,
  benchmark,
}: {
  open: boolean;
  onClose: () => void;
  benchmark: EvalBenchmark;
}) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState(benchmark.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(benchmark.name);
    setError(null);
  }, [open, benchmark.name]);

  const canSubmit = name.trim() !== "" && name.trim() !== benchmark.name && !busy;
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api(benchmarkApiPath(benchmark.id), { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      invalidateBenchmarks(queryClient);
      onClose();
    } catch (e) {
      setError(describeError(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={m.renameBenchmark}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={submit} disabled={!canSubmit}>{busy ? m.saving : m.save}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={m.benchmarkName}>
          <Input id="eval-benchmark-rename" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

/** Replace a harbor case's files with an uploaded one-task archive (PUT). */
export function ReplaceHarborCaseDialog({
  open,
  onClose,
  benchmarkId,
  caseName,
}: {
  open: boolean;
  onClose: () => void;
  benchmarkId: string;
  caseName: string;
}) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const managedApi = useManagedApi();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setError(null);
  }, [open]);

  const canSubmit = !!file && phase === "idle";
  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      setPhase("uploading");
      const uploaded = await managedApi.files.upload({ file: file! });
      setPhase("saving");
      await api(caseApiPath(benchmarkId, caseName), {
        method: "PUT",
        body: JSON.stringify({ source: { type: "upload", file_id: uploaded.id } }),
      });
      invalidateBenchmarks(queryClient);
      onClose();
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
      title={`${m.replaceCaseTitle} · ${caseName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {phase === "uploading" ? m.uploading : phase === "saving" ? m.saving : m.replace}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={m.archive} hint={m.replaceArchiveHint}>
          <Input
            id="eval-case-replace-archive"
            type="file"
            accept=".tar,.tar.gz,.tgz,application/x-tar,application/gzip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}
