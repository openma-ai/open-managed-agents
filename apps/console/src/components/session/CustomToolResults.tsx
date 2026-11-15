import { useState } from "react";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import type { PendingManagedAction } from "@openma/common/session-events/managed";

export function CustomToolResults({ actions, onSubmit }: {
  actions: readonly PendingManagedAction[];
  onSubmit(id: string, text: string): Promise<void>;
}) {
  return <div aria-label="Outstanding custom tool requests">{actions.map(action =>
    <CustomToolResult key={action.id} action={action} onSubmit={onSubmit} />)}</div>;
}

function CustomToolResult({ action, onSubmit }: {
  action: PendingManagedAction;
  onSubmit(id: string, text: string): Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  return <form className="rounded border p-3 space-y-2" onSubmit={async event => {
    event.preventDefault();
    setSending(true); setError("");
    try { await onSubmit(action.id, text); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSending(false); }
  }}>
    <p>Result requested: {String(action.event.name)}</p>
    <pre className="overflow-auto">{JSON.stringify(action.event.input, null, 2)}</pre>
    <Label>Tool result<Textarea aria-label={`Result for ${String(action.event.name)}`} value={text}
      onChange={event => setText(event.target.value)} disabled={sending} className="w-full border rounded" /></Label>
    <Button type="submit" disabled={sending || !text.trim()}>{sending ? "Sending…" : "Submit result"}</Button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
