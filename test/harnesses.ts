import { registerHarness } from "../apps/agent/src/harness/registry";

let initialized = false;

/** Shared fixtures for the combined worker and tests in the same module graph.
 * Only this initializer is idempotent; conflicting registrations still throw.
 * Keep distinct behaviors under distinct ids, rather than overriding factories.
 */
export function registerTestHarnesses(): void {
  if (initialized) return;
  registerHarness("multi-msg", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "msg1" }] });
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "msg2" }] });
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "msg3" }] });
    },
  }));
  registerHarness("thinking-harness", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({ type: "agent.thinking" });
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "after thinking" }] });
    },
  }));
  registerHarness("tool-harness", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({ type: "agent.tool_use", id: "tc_1", name: "bash", input: { command: "ls" } });
      ctx.runtime.broadcast({ type: "agent.tool_result", tool_use_id: "tc_1", content: "exit=0\nfile1.txt" });
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "found files" }] });
    },
  }));
  // #398 bug 3: a parked call closed during the run (steer/interrupt/answer)
  // must not be re-announced as requires_action.
  registerHarness("stale-pending-partial", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({ type: "agent.custom_tool_use", id: "ctu_a", name: "run_tests", input: {} });
      ctx.runtime.broadcast({ type: "agent.custom_tool_use", id: "ctu_b", name: "run_tests", input: {} });
      (ctx.runtime.pendingConfirmations ??= []).push("ctu_a", "ctu_b");
      ctx.runtime.broadcast({ type: "agent.tool_result", tool_use_id: "ctu_a", content: [{ type: "text", text: "closed by steer" }], is_error: true });
    },
  }));
  registerHarness("stale-pending-all", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({ type: "agent.custom_tool_use", id: "ctu_a", name: "run_tests", input: {} });
      (ctx.runtime.pendingConfirmations ??= []).push("ctu_a");
      ctx.runtime.broadcast({ type: "agent.tool_result", tool_use_id: "ctu_a", content: [{ type: "text", text: "closed by steer" }], is_error: true });
    },
  }));
  registerHarness("delayed-harness", () => ({
    async run(ctx) {
      await new Promise((r) => setTimeout(r, 200));
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "delayed response" }] });
    },
  }));
  registerHarness("partial-crash", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "before crash" }] });
      throw new Error("partial crash");
    },
  }));
  registerHarness("history-reader", () => ({
    async run(ctx) {
      const count = ctx.runtime.history.getMessages().length;
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: `msgs=${count}` }],
      });
    },
  }));
  registerHarness("config-reader", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: `system=${ctx.agent.system || "none"}` }],
      });
    },
  }));
  registerHarness("system-prompt-reader", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: ctx.systemPrompt }],
      });
    },
  }));
  registerHarness("usage-reporter", () => ({
    async run(ctx) {
      if (ctx.runtime.reportUsage) {
        await ctx.runtime.reportUsage(100, 50);
      }
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: "usage reported" }],
      });
    },
  }));
  registerHarness("sh-noop", () => ({ async run() {} }));
  registerHarness("crash-sh", () => ({
    async run() {
      throw new Error("sh crash");
    },
  }));
  registerHarness("echo-user-input", () => ({
    async run(ctx) {
      const text = ctx.userMessage.content[0].text;
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: `echo: ${text}` }],
      });
    },
  }));
  registerHarness("exact-echo-sh", () => ({
    async run(ctx) {
      const text = ctx.userMessage.content[0]?.text || "";
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: `echo: ${text}` }],
      });
    },
  }));
  registerHarness("content-reader-sh", () => ({
    async run(ctx) {
      const blocks = ctx.userMessage.content.length;
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: `blocks=${blocks}` }],
      });
    },
  }));
  registerHarness("noop", () => ({ async run() {} }));
  registerHarness("noop-test", () => ({ async run() {} }));
  registerHarness("files-test", () => ({ async run() {} }));
  registerHarness("cross-noop", () => ({ async run() {} }));
  registerHarness("edge-noop", () => ({ async run() {} }));
  registerHarness("parity-noop", () => ({ async run() {} }));
  registerHarness("eval-test", () => ({
    async run(ctx) {
      const text = ctx.userMessage?.content?.[0]?.text || "";
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: `eval-ack: ${text}` }],
      });
    },
  }));
  registerHarness("test", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: "test response" }],
      });
    },
  }));
  registerHarness("echo-test", () => ({
    async run(ctx) {
      const text = ctx.userMessage?.content?.[0]?.text || "";
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: `echo: ${text}` }],
      });
    },
  }));
  registerHarness("features-echo-test", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: "echo reply" }],
      });
    },
  }));
  registerHarness("parity-echo", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: "parity echo" }],
      });
    },
  }));
  registerHarness("cross-echo", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: "cross-echo reply" }],
      });
    },
  }));
  registerHarness("outcome-test", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: "Here is the fibonacci script:\n\nfunction fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }" }],
      });
    },
  }));
  registerHarness("outcome-multi", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: "Step 1: Setting up REST API" }],
      });
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: "Step 2: Added GET /health endpoint returning JSON" }],
      });
    },
  }));
  registerHarness("trajectory-test", () => ({
    async run(ctx) {
      ctx.runtime.broadcast({
        type: "agent.tool_use",
        id: "tu-test-1",
        name: "bash",
        input: { command: "echo hi" },
      });
      ctx.runtime.broadcast({
        type: "agent.tool_result",
        tool_use_id: "tu-test-1",
        content: "hi\nexit=0",
      });
      ctx.runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: "hello from trajectory test" }],
      });
    },
  }));
  registerHarness("crash-v2", () => ({
    async run() {
      throw new Error("boom v2");
    },
  }));
  initialized = true;
}
