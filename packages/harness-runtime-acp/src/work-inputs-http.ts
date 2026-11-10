import { isDeepStrictEqual } from "node:util";
/** Private, claim-authenticated canonical input transport. No mutation retry:
 * a lost consumption response is unknown, never permission to dispatch. */
export interface WorkInputHttpRow {
  event: Record<string, unknown> & { id: string; type: string; processedAt: string | null };
  position: { revision: number; index: number };
  document: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const position = (value: unknown): value is WorkInputHttpRow["position"] =>
  record(value) && Number.isSafeInteger(value.revision) && Number(value.revision) > 0 &&
  Number.isSafeInteger(value.index) && Number(value.index) >= 0;

export function createWorkInputsHttpClient(options: {
  apiBaseUrl: string;
  sessionId: string;
  sessionsToken: string;
  fetch?: typeof globalThis.fetch;
}) {
  const base = new URL(options.apiBaseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || !options.sessionId || !options.sessionsToken) {
    throw new TypeError("Invalid Work input connection");
  }
  const endpoint = "/v1/oma/sessions/" + encodeURIComponent(options.sessionId);
  async function post(action: string, body: object, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(new URL(endpoint + "/" + action, base), {
        method: "POST", redirect: "error", signal,
        headers: { authorization: "Bearer " + options.sessionsToken, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("Work inputs transport unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Work inputs HTTP " + response.status);
    }
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new Error("Invalid Work inputs JSON"); }
    signal.throwIfAborted();
    return value;
  }
  return {
    async read(input: { cursor: string | null; limit: number; signal: AbortSignal }): Promise<{
      rows: WorkInputHttpRow[]; cursor: string | null; hasMore: boolean;
    }> {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) throw new TypeError("Invalid Work input limit");
      const value = await post("inputs-read", { cursor: input.cursor, limit: input.limit }, input.signal);
      const invalid = () => new Error("Invalid Work input page");
      if (!record(value) || value.type !== "page" || !Array.isArray(value.rows) || value.rows.length > input.limit ||
          typeof value.hasMore !== "boolean" || (value.cursor !== null && (typeof value.cursor !== "string" || !value.cursor)) ||
          (value.rows.length > 0 && (value.cursor === null || value.cursor === input.cursor)) ||
          (value.rows.length === 0 && (value.hasMore || value.cursor !== input.cursor))) throw invalid();
      let previous: WorkInputHttpRow["position"] | undefined;
      const rows: WorkInputHttpRow[] = [];
      for (const row of value.rows) {
        if (!record(row) || !record(row.event) || typeof row.event.id !== "string" || !row.event.id ||
            typeof row.event.type !== "string" || !row.event.type ||
            (row.event.processedAt !== null && typeof row.event.processedAt !== "string") ||
            !position(row.position) || typeof row.document !== "string") throw invalid();
        let raw: unknown;
        try { raw = JSON.parse(row.document); } catch { throw invalid(); }
        if (!record(raw) || raw.id !== row.event.id || raw.type !== row.event.type || raw.processedAt !== row.event.processedAt ||
            !position(raw.source_position) || raw.source_position.revision !== row.position.revision || raw.source_position.index !== row.position.index ||
            (previous && (row.position.revision < previous.revision || (row.position.revision === previous.revision && row.position.index <= previous.index)))) throw invalid();
        const { source_position: _sourcePosition, ...canonicalEvent } = raw;
        if (!isDeepStrictEqual(canonicalEvent, row.event)) throw invalid();
        previous = row.position;
        rows.push({
          event: { ...row.event, id: row.event.id, type: row.event.type, processedAt: row.event.processedAt as string | null },
          position: row.position,
          document: row.document,
        });
      }
      return { rows, cursor: value.cursor as string | null, hasMore: value.hasMore };
    },
    async consume(input: { inputId: string; turnId: string; expectedDocument: string; consumingTurnId?: string; rootInputId?: string; expectedRootDocument?: string; signal: AbortSignal }): Promise<void> {
      const { signal, ...body } = input;
      const result = await post("inputs-consume", { ...body, boundary: "before_dispatch" }, signal);
      if (!record(result) || result.type !== "consumed" || result.inputId !== input.inputId || result.turnId !== input.turnId || result.consumingTurnId !== input.consumingTurnId || result.boundary !== "before_dispatch") {
        throw new Error("Invalid Work input consumption");
      }
    },
  };
}
