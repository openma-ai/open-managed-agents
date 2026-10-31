import { useEffect, useState, type FormEvent } from "react";
import {
  GripVerticalIcon,
  LoaderCircleIcon,
  PencilIcon,
  SendHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SessionQueueDockItem {
  /** Server user.message id; undefined for the optimistic row of a send
   *  that has not been accepted yet. */
  id?: string;
  key: string;
  text: string;
  /** Local action in flight (server has not confirmed yet). */
  busy?: "removing" | "steering" | "editing" | "sending";
}

/**
 * Outcome of enter-edit cancel. The Console fires cancel as soon as the
 * user opens the editor; the HTTP body (OmaQueueCancelResponse) decides:
 * - allowed: still queued, removed — Save re-enqueues the edited text
 * - abandoned: already processing — draft goes to the composer
 */
export type QueueEditBeginResult =
  | { status: "allowed" }
  | { status: "abandoned"; reason: string }
  | { status: "failed" };

export interface SessionQueueDockProps {
  items: SessionQueueDockItem[];
  /** Present only when the agent advertises steering. */
  onSteer?: (id: string) => void | Promise<void>;
  /**
   * Fired the moment the user enters edit mode (pencil click). Must call
   * server cancel and return whether the edit is still allowed.
   */
  onBeginEdit: (id: string) => Promise<QueueEditBeginResult>;
  /** Save after a successful cancel: re-enqueue the edited text. */
  onCommitEdit: (id: string, text: string) => void | Promise<void>;
  /**
   * Edit abandoned (cancel returned already_processing / stream confirmed
   * start). Parent keeps `draft` in the composer for a new send.
   */
  onAbandonEdit: (id: string, draft: string, reason: string) => void;
  /**
   * User left edit without saving after a successful cancel. Parent may
   * re-enqueue the original text so the queue item is not lost.
   */
  onCancelEdit?: (id: string, originalText: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}

/**
 * Backchat's queued-prompt banner: rounded card above the composer, one
 * 36px row per queued message. Queued messages never render in the
 * transcript; they leave this dock when the server starts, steers, or
 * cancels them (OpenMA queue-lifecycle events / cancel HTTP response).
 */
export function SessionQueueDock({
  items,
  onSteer,
  onBeginEdit,
  onCommitEdit,
  onAbandonEdit,
  onCancelEdit,
  onRemove,
}: SessionQueueDockProps) {
  if (items.length === 0) return null;
  return (
    <div
      data-session-queue-dock="true"
      aria-label={`${items.length} queued`}
      className="mx-auto mb-1.5 w-full max-w-3xl rounded-[var(--composer-radius,14px)] bg-bg-surface py-0.5 text-sm leading-5 shadow-sm ring-1 ring-border/60 transition-colors hover:ring-border/80"
    >
      {items.map((item, index) => (
        <QueuedRow
          index={index}
          item={item}
          key={item.key}
          onAbandonEdit={onAbandonEdit}
          onBeginEdit={onBeginEdit}
          onCancelEdit={onCancelEdit}
          onCommitEdit={onCommitEdit}
          onRemove={onRemove}
          onSteer={onSteer}
        />
      ))}
    </div>
  );
}

function QueuedRow({
  item,
  index,
  onSteer,
  onBeginEdit,
  onCommitEdit,
  onAbandonEdit,
  onCancelEdit,
  onRemove,
}: {
  item: SessionQueueDockItem;
  index: number;
} & Omit<SessionQueueDockProps, "items">) {
  const [editing, setEditing] = useState(false);
  /** Cancel succeeded; Save may re-enqueue. */
  const [editAllowed, setEditAllowed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [draft, setDraft] = useState(item.text);
  useEffect(() => setDraft(item.text), [item.text]);
  const id = item.id;
  const disabled = !id || item.busy !== undefined || opening;

  const beginEdit = async () => {
    if (!id || opening) return;
    setOpening(true);
    setDraft(item.text);
    try {
      const result = await onBeginEdit(id);
      if (result.status === "allowed") {
        setEditAllowed(true);
        setEditing(true);
      } else if (result.status === "abandoned") {
        onAbandonEdit(id, item.text, result.reason);
      } else {
        onAbandonEdit(id, item.text, "cancel_failed");
      }
    } finally {
      setOpening(false);
    }
  };

  const leaveEdit = (reenqueueOriginal: boolean) => {
    const wasAllowed = editAllowed;
    setEditing(false);
    setEditAllowed(false);
    setDraft(item.text);
    if (wasAllowed && reenqueueOriginal && id) {
      void Promise.resolve(onCancelEdit?.(id, item.text)).catch(() => undefined);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !id || !editAllowed) return;
    setEditing(false);
    setEditAllowed(false);
    void Promise.resolve(onCommitEdit(id, text)).catch(() => undefined);
  };

  return (
    <div
      data-queued-message-id={id}
      data-queue-busy={item.busy ?? (opening ? "editing" : undefined)}
      className={cn(
        "flex h-9 min-w-0 items-center gap-2.5 px-4 text-xs transition-opacity duration-150",
        (item.busy === "removing" || opening) && "opacity-40",
      )}
    >
      {item.busy || opening ? (
        <LoaderCircleIcon aria-hidden="true" className="size-4 shrink-0 animate-spin text-fg-subtle" />
      ) : (
        <GripVerticalIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
      )}
      {editing ? (
        <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={save}>
          <Input
            aria-label={`Queued message ${index + 1}`}
            autoFocus
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-ring"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") leaveEdit(true);
            }}
            value={draft}
          />
          <Button disabled={!draft.trim() || !editAllowed} size="xs" type="submit" variant="ghost">
            Save
          </Button>
        </form>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium text-fg-muted" title={item.text}>
          {item.text}
        </span>
      )}
      {!editing && (
        <>
          {onSteer && (
            <Button
              aria-label={`Steer queued message ${index + 1}`}
              className="gap-1 px-2 text-xs text-fg-muted"
              data-queue-steer="true"
              disabled={disabled}
              onClick={() => id && void Promise.resolve(onSteer(id)).catch(() => undefined)}
              size="xs"
              title="Send into the running turn"
              type="button"
              variant="ghost"
            >
              <SendHorizontalIcon aria-hidden="true" className="size-3.5" />
              {item.busy === "steering" ? "Steering…" : "Steer"}
            </Button>
          )}
          <Button
            aria-label={`Edit queued message ${index + 1}`}
            disabled={disabled}
            onClick={() => void beginEdit()}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <PencilIcon aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            aria-label={`Remove queued message ${index + 1}`}
            disabled={disabled}
            onClick={() => id && void Promise.resolve(onRemove(id)).catch(() => undefined)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Trash2Icon aria-hidden="true" className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
