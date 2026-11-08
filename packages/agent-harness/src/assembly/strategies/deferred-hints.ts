import {
  appendDeferredIndex,
  formatClaudeCodeDeferredReminder,
  formatIncrementalDeferredChangeReminder,
} from "../deferred-prompt";
import type { DeferredHintStrategy } from "../config";
import type { DeferredToolInvocation } from "./exposure";

export interface DeferredHintPlan {
  toolSearchEnabled: boolean;
  deferredNames: string[];
  /** How deferred tools are called; hint wording follows it. Defaults to `direct`. */
  invocation?: DeferredToolInvocation;
}

export interface DeferredHintBootstrapMessage {
  role: "user";
  content: string;
  timestamp: number;
}

export interface DeferredHintCoordinator {
  augmentSystemPrompt(baseSystemPrompt: string, plan: DeferredHintPlan): string;
  bootstrapTurnMessages(plan: DeferredHintPlan): DeferredHintBootstrapMessage[];
  prepareNextTurn(
    plan: DeferredHintPlan,
    lastDeferredHintKey: string,
  ): {
    messages?: DeferredHintBootstrapMessage[];
    nextDeferredHintKey: string;
  };
  initialDeferredHintKey(plan: DeferredHintPlan): string;
}

function deferredHintKey(deferredNames: string[]): string {
  return deferredNames.length === 0 ? "" : deferredNames.slice().sort().join("\0");
}

function userReminder(content: string): DeferredHintBootstrapMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function createClaudeCodeStrategy(): DeferredHintCoordinator {
  return {
    augmentSystemPrompt(base, plan) {
      if (!plan.toolSearchEnabled) return base;
      return base;
    },
    bootstrapTurnMessages(plan) {
      if (!plan.toolSearchEnabled || plan.deferredNames.length === 0) return [];
      return [userReminder(formatClaudeCodeDeferredReminder(plan.deferredNames, plan.invocation))];
    },
    prepareNextTurn(plan) {
      if (!plan.toolSearchEnabled || plan.deferredNames.length === 0) {
        return { nextDeferredHintKey: "" };
      }
      const key = deferredHintKey(plan.deferredNames);
      return {
        messages: [userReminder(formatClaudeCodeDeferredReminder(plan.deferredNames, plan.invocation))],
        nextDeferredHintKey: key,
      };
    },
    initialDeferredHintKey() {
      return "";
    },
  };
}

function createPiStrategy(): DeferredHintCoordinator {
  return {
    augmentSystemPrompt(base, plan) {
      if (!plan.toolSearchEnabled) return base;
      return appendDeferredIndex(base, plan.deferredNames, plan.invocation);
    },
    bootstrapTurnMessages() {
      return [];
    },
    prepareNextTurn(plan, lastKey) {
      return { nextDeferredHintKey: lastKey };
    },
    initialDeferredHintKey() {
      return "";
    },
  };
}

function createCodexStrategy(): DeferredHintCoordinator {
  return {
    augmentSystemPrompt(base) {
      return base;
    },
    bootstrapTurnMessages() {
      return [];
    },
    prepareNextTurn(plan, lastKey) {
      return { nextDeferredHintKey: lastKey };
    },
    initialDeferredHintKey() {
      return "";
    },
  };
}

function createIncrementalStrategy(): DeferredHintCoordinator {
  return {
    augmentSystemPrompt(base, plan) {
      if (!plan.toolSearchEnabled) return base;
      return appendDeferredIndex(base, plan.deferredNames, plan.invocation);
    },
    bootstrapTurnMessages() {
      return [];
    },
    prepareNextTurn(plan, lastKey) {
      if (!plan.toolSearchEnabled || plan.deferredNames.length === 0) {
        return { nextDeferredHintKey: "" };
      }
      const key = deferredHintKey(plan.deferredNames);
      if (key === lastKey) {
        return { nextDeferredHintKey: lastKey };
      }
      return {
        messages: [userReminder(formatIncrementalDeferredChangeReminder(plan.deferredNames.length))],
        nextDeferredHintKey: key,
      };
    },
    initialDeferredHintKey(plan) {
      if (!plan.toolSearchEnabled) return "";
      return deferredHintKey(plan.deferredNames);
    },
  };
}

export function createDeferredHintCoordinator(
  strategy: DeferredHintStrategy,
): DeferredHintCoordinator {
  switch (strategy) {
    case "claude_code":
      return createClaudeCodeStrategy();
    case "pi":
      return createPiStrategy();
    case "codex":
      return createCodexStrategy();
    case "incremental":
      return createIncrementalStrategy();
    default:
      return createClaudeCodeStrategy();
  }
}
