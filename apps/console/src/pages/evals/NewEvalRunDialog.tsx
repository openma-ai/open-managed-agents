import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Select, SelectOption } from "../../components/Select";
import { useI18n } from "../../i18n";
import { useApi } from "../../lib/api";
import { useApiQuery, useQueryClient } from "../../lib/useApiQuery";
import {
  BENCHMARKS_BASE,
  EVALS_BASE,
  benchmarkApiPath,
  isRunnableCase,
  kindLabel,
  type AgentOption,
  type EnvironmentOption,
  isEvalOracleAgent,
  type CreateEvalRunRequest,
  type CreateEvalRunResponse,
  type EvalBenchmark,
} from "./shared";

interface NewEvalRunDialogProps {
  open: boolean;
  onClose: () => void;
  /** Preselect a benchmark (e.g. the "Run" button on a benchmark). */
  initialBenchmarkId?: string;
}

export function NewEvalRunDialog({ open, onClose, initialBenchmarkId }: NewEvalRunDialogProps) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();

  const [benchmarkId, setBenchmarkId] = useState(initialBenchmarkId ?? "");
  const [mode, setMode] = useState<"agent" | "oracle">("agent");
  const [agentId, setAgentId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [caseNames, setCaseNames] = useState<string[]>([]);
  const [trials, setTrials] = useState("1");
  const [concurrency, setConcurrency] = useState("4");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed on every open so a benchmark's "Run" button preselects it.
  useEffect(() => {
    if (!open) return;
    setBenchmarkId(initialBenchmarkId ?? "");
    setCaseNames([]);
    setError(null);
  }, [open, initialBenchmarkId]);

  const { data: benchmarksRes } = useApiQuery<{ data: EvalBenchmark[] }>(open ? BENCHMARKS_BASE : null);
  const benchmarks = benchmarksRes?.data ?? [];

  const { data: benchmark } = useApiQuery<EvalBenchmark>(
    open && benchmarkId ? benchmarkApiPath(benchmarkId) : null,
  );
  const current = benchmark?.id === benchmarkId ? benchmark : undefined;
  const cases = current?.cases ?? [];
  const isMessages = current?.kind === "messages";
  // Oracle needs solution/solve.sh: harbor only.
  useEffect(() => { if (isMessages) setMode("agent"); }, [isMessages]);

  const envParams = useMemo(() => ({ limit: "200" }), []);
  const { data: envRes } = useApiQuery<{ data: EnvironmentOption[] }>(
    open && isMessages ? "/v1/environments" : null,
    envParams,
  );
  const environments = (envRes?.data ?? []).filter((e) => !e.archived_at);

  const agentsParams = useMemo(() => ({ limit: "200" }), []);
  const { data: agentsRes } = useApiQuery<{ data: AgentOption[] }>(
    open ? "/v1/agents" : null,
    agentsParams,
  );
  const agents = (agentsRes?.data ?? []).filter((a) => !a.archived_at && !isEvalOracleAgent(a));

  const trialsN = Number(trials);
  const concurrencyN = Number(concurrency);
  const numbersValid =
    Number.isInteger(trialsN) && trialsN >= 1 && trialsN <= 20 &&
    Number.isInteger(concurrencyN) && concurrencyN >= 1 && concurrencyN <= 32;
  const canSubmit =
    !!current && (mode === "oracle" || !!agentId) && (!isMessages || !!environmentId)
    && numbersValid && !submitting;

  const toggleCase = (name: string, checked: boolean) =>
    setCaseNames((prev) =>
      checked ? [...prev.filter((n) => n !== name), name] : prev.filter((n) => n !== name),
    );

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const body: CreateEvalRunRequest = {
      benchmark_id: benchmarkId,
      mode,
      ...(mode === "agent" ? { agent_id: agentId } : {}),
      ...(isMessages ? { environment_id: environmentId } : {}),
      ...(caseNames.length > 0 ? { case_names: caseNames } : {}),
      trials: trialsN,
      concurrency: concurrencyN,
    };
    try {
      const res = await api<CreateEvalRunResponse>(`${EVALS_BASE}/runs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      void queryClient.invalidateQueries({ queryKey: [`${EVALS_BASE}/runs`] });
      onClose();
      nav(`/evals/${res.run_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={m.newRunTitle}
      subtitle={m.newRunSubtitle}
      maxWidth="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? m.starting : m.startRun}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={m.benchmark} hint={benchmarks.length === 0 ? m.noBenchmarksForRun : undefined}>
          <Select
            id="eval-run-benchmark"
            value={benchmarkId}
            onValueChange={(v) => { setBenchmarkId(v); setCaseNames([]); }}
            placeholder={m.selectBenchmark}
          >
            {benchmarks.map((b) => (
              <SelectOption key={b.id} value={b.id}>
                {b.name} · {kindLabel(t, b.kind)} ({b.runnable_count}/{b.case_count})
              </SelectOption>
            ))}
          </Select>
        </Field>

        <Field label={m.mode} hint={mode === "oracle" ? m.oracleHint : undefined}>
          <Select
            id="eval-run-mode"
            value={mode}
            onValueChange={(v) => setMode(v as "agent" | "oracle")}
          >
            <SelectOption value="agent">{m.modeAgent}</SelectOption>
            <SelectOption value="oracle" disabled={isMessages}>
              {isMessages ? m.oracleHarborOnly : m.modeOracle}
            </SelectOption>
          </Select>
        </Field>

        {mode === "agent" && (
          <Field label={m.agent} error={!agentId ? m.agentRequired : undefined}>
            <Select
              id="eval-run-agent"
              value={agentId}
              onValueChange={setAgentId}
              placeholder={m.selectAgent}
            >
              {agents.map((a) => (
                <SelectOption key={a.id} value={a.id}>{a.name || a.id}</SelectOption>
              ))}
            </Select>
          </Field>
        )}

        {isMessages && (
          <Field label={m.environment} error={!environmentId ? m.environmentRequired : undefined}>
            <Select
              id="eval-run-environment"
              value={environmentId}
              onValueChange={setEnvironmentId}
              placeholder={m.selectEnvironment}
            >
              {environments.map((e) => (
                <SelectOption key={e.id} value={e.id}>{e.name || e.id}</SelectOption>
              ))}
            </Select>
          </Field>
        )}

        {current && cases.length > 0 && (
          <fieldset>
            <legend className="block text-sm font-medium text-fg mb-1.5">{m.caseSubset}</legend>
            <p className="text-sm text-fg-muted mb-2">{m.caseSubsetHint}</p>
            <div className="max-h-48 overflow-y-auto space-y-1.5 rounded-md border border-border p-2">
              {cases.map((task) => {
                const runnable = isRunnableCase(task);
                const id = `eval-run-case-${task.name}`;
                return (
                  <div key={task.name} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      disabled={!runnable}
                      checked={caseNames.includes(task.name)}
                      onCheckedChange={(c) => toggleCase(task.name, c === true)}
                    />
                    <Label
                      htmlFor={id}
                      className={`font-mono text-xs ${runnable ? "text-fg" : "text-fg-subtle"}`}
                    >
                      {task.name}
                      {!runnable && <span className="ml-2 font-sans text-warning">({m.notRunnable})</span>}
                    </Label>
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={m.trialsLabel}>
            <Input
              id="eval-run-trials"
              type="number"
              min={1}
              max={20}
              value={trials}
              onChange={(e) => setTrials(e.target.value)}
            />
          </Field>
          <Field label={m.concurrencyLabel}>
            <Input
              id="eval-run-concurrency"
              type="number"
              min={1}
              max={32}
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
            />
          </Field>
        </div>
        {!numbersValid && <p className="text-sm text-danger">{m.invalidNumbers}</p>}

        {error && (
          <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
