import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { useI18n } from "../../i18n";
import { useApi } from "../../lib/api";
import { useQueryClient } from "../../lib/useApiQuery";
import { useManagedApi } from "../../lib/useManagedApi";
import {
  BENCHMARKS_BASE,
  benchmarkApiPath,
  benchmarkPath,
  describeError,
  invalidateBenchmarks,
  type EvalBenchmark,
  type SyncEvalBenchmarkRequest,
  type SyncEvalBenchmarkResponse,
} from "./shared";

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
      {error}
    </div>
  );
}

/** New messages benchmark. Harbor benchmarks are imported (HarborSourceDialog). */
export function CreateBenchmarkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
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
        body: JSON.stringify({ kind: "messages", name: name.trim() }),
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

/** Re-read a harbor benchmark's source (POST /sync). Upload sources need a
 *  new archive; git sources may pass another ref. */
export function SyncBenchmarkDialog({
  open,
  onClose,
  benchmark,
  onSynced,
}: {
  open: boolean;
  onClose: () => void;
  benchmark: EvalBenchmark;
  onSynced: (res: SyncEvalBenchmarkResponse) => void;
}) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const managedApi = useManagedApi();
  const queryClient = useQueryClient();
  const source = benchmark.source;
  const [file, setFile] = useState<File | null>(null);
  const [ref, setRef] = useState("");
  const [phase, setPhase] = useState<"idle" | "uploading" | "syncing">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setRef("");
    setError(null);
  }, [open]);

  const isUpload = source?.type === "upload";
  const isGit = source?.type === "git";
  const canSubmit = phase === "idle" && (!isUpload || !!file);
  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      const body: SyncEvalBenchmarkRequest = {};
      if (isUpload) {
        setPhase("uploading");
        const uploaded = await managedApi.files.upload({ file: file! });
        body.file_id = uploaded.id;
      } else if (isGit && ref.trim()) {
        body.ref = ref.trim();
      }
      setPhase("syncing");
      const res = await api<SyncEvalBenchmarkResponse>(`${benchmarkApiPath(benchmark.id)}/sync`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      invalidateBenchmarks(queryClient);
      onSynced(res);
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
      title={m.syncTitle}
      subtitle={m.syncHint}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {phase === "uploading" ? m.uploading : phase === "syncing" ? m.syncing : m.sync}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {isUpload && (
          <Field label={m.archive} hint={m.syncUploadHint}>
            <Input
              id="eval-sync-archive"
              type="file"
              accept=".tar,.tar.gz,.tgz,application/x-tar,application/gzip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
        )}
        {isGit && source?.type === "git" && (
          <Field label={m.gitRef} hint={m.syncRefHint.replace("{ref}", source.ref ?? "HEAD")}>
            <Input
              id="eval-sync-ref"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder={source.ref ?? "HEAD"}
              autoComplete="off"
            />
          </Field>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}
