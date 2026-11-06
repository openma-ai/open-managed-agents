import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Select, SelectOption } from "../../components/Select";
import { useI18n } from "../../i18n";
import { useApi } from "../../lib/api";
import { useQueryClient } from "../../lib/useApiQuery";
import {
  benchmarkApiPath,
  caseApiPath,
  describeError,
  invalidateBenchmarks,
  type MessagesCaseInput,
  type MessagesEvalCase,
} from "./shared";

export const REWARD_TYPES = ["verifiable", "script", "reward_model", "composite"] as const;
type RewardType = (typeof REWARD_TYPES)[number];

/** Starting spec per type (eval-core RewardSpec), so the JSON editor shows
 *  the fields each verifier reads. */
const REWARD_TEMPLATES: Record<RewardType, Record<string, unknown>> = {
  verifiable: { type: "verifiable", scorer: "bashExit", opts: { expectedCode: 0 } },
  script: { type: "script", verify_script: "true" },
  reward_model: { type: "reward_model", endpoint: "" },
  composite: { type: "composite", components: [] },
};

const CASE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function rewardTypeOf(reward: unknown): string | undefined {
  return reward && typeof reward === "object" && typeof (reward as { type?: unknown }).type === "string"
    ? (reward as { type: string }).type
    : undefined;
}

interface Draft {
  name: string;
  messages: string[];
  rewardType: "" | RewardType;
  rewardJson: string;
  setupScript: string;
  setupFiles: { path: string; content: string }[];
  timeoutMs: string;
}

function draftFrom(c?: MessagesEvalCase): Draft {
  const type = rewardTypeOf(c?.reward);
  return {
    name: c?.name ?? "",
    messages: c?.messages.length ? [...c.messages] : [""],
    rewardType: (REWARD_TYPES as readonly string[]).includes(type ?? "") ? (type as RewardType) : "",
    rewardJson: c?.reward !== undefined ? JSON.stringify(c.reward, null, 2) : "",
    setupScript: c?.setup_script ?? "",
    setupFiles: c?.setup_files?.map((f) => ({ ...f })) ?? [],
    timeoutMs: c?.timeout_ms != null ? String(c.timeout_ms) : "",
  };
}

interface MessagesCaseFormProps {
  /** Existing case to edit; omitted when adding. */
  initial?: MessagesEvalCase;
  /** Edit mode keeps the case name fixed (the path names the case). */
  nameLocked?: boolean;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (input: MessagesCaseInput) => Promise<void>;
  onCancel?: () => void;
}

/** Form for a messages case: name, ordered user messages, reward spec,
 *  setup script/files and timeout. Validates locally before submitting. */
export function MessagesCaseForm({
  initial,
  nameLocked,
  submitLabel,
  busyLabel,
  onSubmit,
  onCancel,
}: MessagesCaseFormProps) {
  const { t } = useI18n();
  const m = t.evals;
  const [d, setD] = useState<Draft>(() => draftFrom(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  // Validation
  const nameError = !nameLocked && !CASE_NAME_RE.test(d.name.trim())
    ? d.name.trim() ? m.invalidCaseName : m.nameRequired
    : undefined;
  const messages = d.messages.map((s) => s).filter((s) => s.trim() !== "");
  const messagesError = messages.length === 0 ? m.messagesRequired : undefined;
  let reward: unknown;
  let rewardError: string | undefined;
  if (d.rewardType) {
    try {
      const parsed: unknown = d.rewardJson.trim() ? JSON.parse(d.rewardJson) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) rewardError = m.rewardMustBeObject;
      else reward = { ...(parsed as Record<string, unknown>), type: d.rewardType };
    } catch {
      rewardError = m.invalidJson;
    }
  }
  const timeoutN = d.timeoutMs.trim() ? Number(d.timeoutMs) : undefined;
  const timeoutError = timeoutN !== undefined && !(Number.isInteger(timeoutN) && timeoutN > 0)
    ? m.invalidTimeout
    : undefined;
  const valid = !nameError && !messagesError && !rewardError && !timeoutError;

  const changeRewardType = (v: string) => {
    const type = v === "none" ? "" : (v as RewardType);
    setD((p) => {
      if (!type) return { ...p, rewardType: "" };
      // Keep the user's spec, retargeted to the new type; seed a template
      // when the editor is empty or holds something unparsable.
      let next: Record<string, unknown> = REWARD_TEMPLATES[type];
      try {
        const cur: unknown = p.rewardJson.trim() ? JSON.parse(p.rewardJson) : null;
        if (cur && typeof cur === "object" && !Array.isArray(cur) && rewardTypeOf(cur) === type) {
          next = cur as Record<string, unknown>;
        }
      } catch { /* replace with template */ }
      return { ...p, rewardType: type, rewardJson: JSON.stringify({ ...next, type }, null, 2) };
    });
  };

  const moveMessage = (i: number, delta: number) =>
    setD((p) => {
      const j = i + delta;
      if (j < 0 || j >= p.messages.length) return p;
      const next = [...p.messages];
      [next[i], next[j]] = [next[j], next[i]];
      return { ...p, messages: next };
    });

  const submit = async () => {
    setTouched(true);
    if (!valid || busy) return;
    const files = d.setupFiles.filter((f) => f.path.trim() !== "");
    const input: MessagesCaseInput = {
      name: nameLocked ? (initial?.name ?? d.name.trim()) : d.name.trim(),
      messages,
      ...(reward !== undefined ? { reward } : {}),
      ...(d.setupScript.trim() ? { setup_script: d.setupScript } : {}),
      ...(files.length > 0 ? { setup_files: files.map((f) => ({ path: f.path.trim(), content: f.content })) } : {}),
      ...(timeoutN !== undefined ? { timeout_ms: timeoutN } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      await onSubmit(input);
    } catch (e) {
      setError(describeError(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="messages-case-form">
      <Field label={m.caseName} hint={nameLocked ? undefined : m.caseNameHint} error={touched ? nameError : undefined}>
        <Input
          id="eval-case-name"
          value={d.name}
          disabled={nameLocked}
          onChange={(e) => set("name", e.target.value)}
          className="font-mono"
          autoComplete="off"
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="block text-sm font-medium text-fg mb-1.5">{m.messages}</legend>
        {d.messages.map((msg, i) => {
          const label = m.messageN.replace("{n}", String(i + 1));
          return (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-2 w-5 shrink-0 text-right text-xs text-fg-subtle tabular-nums">{i + 1}</span>
              <Textarea
                aria-label={label}
                value={msg}
                onChange={(e) => set("messages", d.messages.map((x, j) => (j === i ? e.target.value : x)))}
                rows={2}
                className="min-w-0 flex-1"
              />
              <div className="flex shrink-0 flex-col gap-0.5">
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`${m.moveUp} ${i + 1}`} disabled={i === 0} onClick={() => moveMessage(i, -1)}>
                  <ArrowUpIcon className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`${m.moveDown} ${i + 1}`} disabled={i === d.messages.length - 1} onClick={() => moveMessage(i, 1)}>
                  <ArrowDownIcon className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`${m.removeMessage} ${i + 1}`} disabled={d.messages.length === 1} onClick={() => set("messages", d.messages.filter((_, j) => j !== i))}>
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
        <Button type="button" variant="outline" size="sm" onClick={() => set("messages", [...d.messages, ""])}>
          <PlusIcon className="size-4" />
          {m.addMessage}
        </Button>
        {touched && messagesError && <p className="text-sm text-danger">{messagesError}</p>}
      </fieldset>

      <Field label={m.rewardType}>
        <Select id="eval-case-reward-type" value={d.rewardType || "none"} onValueChange={changeRewardType} placeholder={m.rewardType}>
          <SelectOption value="none">{m.noReward}</SelectOption>
          {REWARD_TYPES.map((r) => <SelectOption key={r} value={r}>{r}</SelectOption>)}
        </Select>
      </Field>

      {d.rewardType && (
        <Field label={m.rewardSpec} hint={m.rewardSpecHint} error={rewardError}>
          <Textarea
            id="eval-case-reward-json"
            value={d.rewardJson}
            onChange={(e) => set("rewardJson", e.target.value)}
            rows={6}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
      )}

      <Field label={m.setupScriptLabel} hint={m.setupScriptHint}>
        <Textarea
          id="eval-case-setup-script"
          value={d.setupScript}
          onChange={(e) => set("setupScript", e.target.value)}
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="block text-sm font-medium text-fg mb-1.5">{m.setupFiles}</legend>
        {d.setupFiles.map((f, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Input
                aria-label={`${m.filePath} ${i + 1}`}
                value={f.path}
                placeholder="/workspace/input.txt"
                onChange={(e) => set("setupFiles", d.setupFiles.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
                className="font-mono text-xs"
              />
              <Textarea
                aria-label={`${m.fileContent} ${i + 1}`}
                value={f.content}
                onChange={(e) => set("setupFiles", d.setupFiles.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                rows={2}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`${m.removeFile} ${i + 1}`} onClick={() => set("setupFiles", d.setupFiles.filter((_, j) => j !== i))}>
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => set("setupFiles", [...d.setupFiles, { path: "", content: "" }])}>
          <PlusIcon className="size-4" />
          {m.addFile}
        </Button>
      </fieldset>

      <Field label={m.timeoutMs} error={timeoutError}>
        <Input
          id="eval-case-timeout"
          type="number"
          min={1}
          value={d.timeoutMs}
          onChange={(e) => set("timeoutMs", e.target.value)}
        />
      </Field>

      {error && (
        <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>{t.common.cancel}</Button>}
        <Button type="button" onClick={submit} disabled={busy || (touched && !valid)}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** Add (POST) or edit (PUT) a messages case in a modal. */
export function MessagesCaseDialog({
  open,
  onClose,
  benchmarkId,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  benchmarkId: string;
  existing?: MessagesEvalCase;
}) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const queryClient = useQueryClient();

  const submit = async (input: MessagesCaseInput) => {
    if (existing) {
      await api(caseApiPath(benchmarkId, existing.name), { method: "PUT", body: JSON.stringify(input) });
    } else {
      await api(`${benchmarkApiPath(benchmarkId)}/cases`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    }
    invalidateBenchmarks(queryClient);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={existing ? m.editCase : m.addCase} maxWidth="max-w-2xl">
      {open && (
        <MessagesCaseForm
          key={existing?.name ?? "new"}
          initial={existing}
          nameLocked={!!existing}
          submitLabel={existing ? m.save : m.add}
          busyLabel={existing ? m.saving : m.adding}
          onSubmit={submit}
          onCancel={onClose}
        />
      )}
    </Modal>
  );
}
