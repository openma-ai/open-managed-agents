import type { ModelMessage } from "ai";
import {
  DefaultHarness, type FileResolver,
} from "@open-managed-agents/agent-harness";
import type { SessionEvent } from "@open-managed-agents/shared";
import { managedNodeEventsToMessagesAsync } from "./node-managed-harness-runtime.js";

export class ManagedNodeDefaultHarness extends DefaultHarness {
  override deriveModelContext(
    events: SessionEvent[],
    options?: { fileFetcher?: FileResolver },
  ): Promise<ModelMessage[]> {
    return managedNodeEventsToMessagesAsync(events, options?.fileFetcher);
  }
}
