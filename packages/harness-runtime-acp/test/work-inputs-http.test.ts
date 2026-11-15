import { expect, it, vi } from "vitest";
import { createWorkInputsHttpClient } from "../src/work-inputs-http";

const event = { id: "input-1", type: "user.message", processedAt: null, content: [{ type: "text", text: "hello" }] };
const row = { event, position: { revision: 2, index: 0 }, document: JSON.stringify({ ...event, source_position: { revision: 2, index: 0 } }) };
const options = { apiBaseUrl: "https://control.test/base", sessionId: "session/1", sessionsToken: "sealed-work-credential" };
const signal = new AbortController().signal;

it("reads bounded canonical inputs with the sealed credential, preserving null and exact CAS bytes", async () => {
  const fetcher = vi.fn(async (url, init) => {
    expect(String(url)).toBe("https://control.test/v1/oma/sessions/session%2F1/inputs-read");
    expect(init).toMatchObject({ method: "POST", redirect: "error", signal });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sealed-work-credential");
    expect(JSON.parse(init.body)).toEqual({ cursor: null, limit: 100 });
    return Response.json({ type: "page", rows: [row], cursor: "opaque-tail", hasMore: false });
  });
  const client = createWorkInputsHttpClient({ ...options, fetch: fetcher });
  expect(await client.read({ cursor: null, limit: 100, signal })).toEqual({ rows: [row], cursor: "opaque-tail", hasMore: false });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("retries only a transient idempotent page read", async () => {
  let attempts = 0;
  const client = createWorkInputsHttpClient({ ...options, fetch: async () => {
    attempts++;
    if (attempts === 1) throw new TypeError("fetch failed");
    return Response.json({ type: "page", rows: [], cursor: null, hasMore: false });
  } });
  await expect(client.read({ cursor: null, limit: 10, signal })).resolves.toEqual({ rows: [], cursor: null, hasMore: false });
  expect(attempts).toBe(2);
});

it("can quiesce hot page reads while the cold snapshot path runs", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn(async () => Response.json({ type: "page", rows: [], cursor: null, hasMore: false }));
  const client = createWorkInputsHttpClient({ ...options, fetch: fetcher, beforeRead: () => gate });
  const pending = client.read({ cursor: null, limit: 10, signal });
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled();
  release();
  await expect(pending).resolves.toEqual({ rows: [], cursor: null, hasMore: false });
  await client.waitForReadsIdle();
});

it("retains the server cursor on an empty tail page", async () => {
  const client = createWorkInputsHttpClient({ ...options, fetch: async () => Response.json({ type: "page", rows: [], cursor: "tail", hasMore: false }) });
  expect(await client.read({ cursor: "tail", limit: 10, signal })).toEqual({ rows: [], cursor: "tail", hasMore: false });
});

it("only consumes before dispatch with the original document and stable turn id", async () => {
  const client = createWorkInputsHttpClient({ ...options, fetch: async (url, init) => {
    expect(String(url)).toContain("/inputs-consume");
    expect(JSON.parse(String(init?.body))).toEqual({ inputId: "input-1", turnId: "input-1", expectedDocument: row.document, boundary: "before_dispatch" });
    return Response.json({ type: "consumed", inputId: "input-1", turnId: "input-1", boundary: "before_dispatch" });
  } });
  await expect(client.consume({ inputId: "input-1", turnId: "input-1", expectedDocument: row.document, signal })).resolves.toBeUndefined();
});

it.each([401, 409, 503])("does not retry or expose response secrets on HTTP %s", async status => {
  const fetcher = vi.fn(async () => new Response("secret-sentinel", { status }));
  const client = createWorkInputsHttpClient({ ...options, fetch: fetcher });
  await expect(client.consume({ inputId: "input-1", turnId: "input-1", expectedDocument: row.document, signal })).rejects.toThrow(`Work inputs HTTP ${status}`);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  { type: "page", rows: [row], cursor: null, hasMore: false },
  { type: "page", rows: [], cursor: "tail", hasMore: true },
  { type: "page", rows: [{ ...row, document: "{}" }], cursor: "tail", hasMore: false },
  { type: "page", rows: [{ ...row, position: { revision: 0, index: 0 } }], cursor: "tail", hasMore: false },
])("fails closed on malformed canonical pages", async page => {
  const client = createWorkInputsHttpClient({ ...options, fetch: async () => Response.json(page) });
  await expect(client.read({ cursor: null, limit: 10, signal })).rejects.toThrow("Invalid Work input page");
});

it("rejects mismatched consumption receipts rather than treating them as success", async () => {
  const client = createWorkInputsHttpClient({ ...options, fetch: async () => Response.json({ type: "consumed", inputId: "other", turnId: "input-1", boundary: "after_acceptance" }) });
  await expect(client.consume({ inputId: "input-1", turnId: "input-1", expectedDocument: row.document, signal })).rejects.toThrow("Invalid Work input consumption");
});

it("does not send requests after cancellation", async () => {
  const fetcher = vi.fn();
  const client = createWorkInputsHttpClient({ ...options, fetch: fetcher });
  await expect(client.read({ cursor: null, limit: 10, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects a reader row whose content differs from its exact CAS document", async () => {
 const client=createWorkInputsHttpClient({...options,fetch:async()=>Response.json({type:"page",rows:[{...row,event:{...event,content:[{type:"text",text:"forged"}]}}],cursor:"tail",hasMore:false})});
 await expect(client.read({cursor:null,limit:10,signal})).rejects.toThrow("Invalid Work input page");
});

it("requires an echoed consuming identity when absorbing an answer",async()=>{
 const request={inputId:"answer",turnId:"answer-dispatch",expectedDocument:"answer-bytes",consumingTurnId:"root-turn",rootInputId:"root",expectedRootDocument:"server-root-bytes",signal};
 const client=createWorkInputsHttpClient({...options,fetch:async(_url,init)=>{
  expect(JSON.parse(String(init?.body))).toEqual({...request,signal:undefined,boundary:"before_dispatch"});
  return Response.json({type:"consumed",inputId:"answer",turnId:"answer-dispatch",boundary:"before_dispatch"});
 }});
 await expect(client.consume(request)).rejects.toThrow("Invalid Work input consumption");
});
