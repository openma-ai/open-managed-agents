import { describe, expectTypeOf, it } from "vitest";
import type {
  Agent,
  AgentMcpServer,
  AgentMcpServerInput,
  AgentMultiagent,
  AgentSkill,
  AgentTool,
  AgentToolInput,
  CreateAgentCommand,
  Session,
  SessionAgentMultiagent,
  SessionThreadAgent,
  SessionAgentSelector,
  UpdateAgentCommand,
  UpdateSessionCommand,
} from "../src/index";

describe("application-native Agent definition boundary", () => {
  it("exposes resolved definition types in Agent, Session, and Thread snapshots", () => {
    expectTypeOf<Agent["mcpServers"]>().toEqualTypeOf<AgentMcpServer[]>();
    expectTypeOf<Agent["skills"]>().toEqualTypeOf<AgentSkill[]>();
    expectTypeOf<Agent["tools"]>().toEqualTypeOf<AgentTool[]>();
    expectTypeOf<Agent["multiagent"]>().toEqualTypeOf<
      AgentMultiagent | null
    >();

    expectTypeOf<Session["agent"]["mcpServers"]>().toEqualTypeOf<
      AgentMcpServer[]
    >();
    expectTypeOf<Session["agent"]["skills"]>().toEqualTypeOf<AgentSkill[]>();
    expectTypeOf<Session["agent"]["tools"]>().toEqualTypeOf<AgentTool[]>();
    expectTypeOf<Session["agent"]["multiagent"]>().toEqualTypeOf<
      SessionAgentMultiagent | null
    >();

    expectTypeOf<
      Extract<SessionThreadAgent, { type: "agent" }>["tools"]
    >().toEqualTypeOf<AgentTool[]>();

    expectTypeOf<CreateAgentCommand["tools"]>().toEqualTypeOf<
      AgentToolInput[] | undefined
    >();
    expectTypeOf<UpdateAgentCommand["tools"]>().toEqualTypeOf<
      AgentToolInput[] | null | undefined
    >();
    expectTypeOf<
      Extract<SessionAgentSelector, { type: "overrides" }>["tools"]
    >().toEqualTypeOf<AgentToolInput[] | undefined>();
    expectTypeOf<UpdateSessionCommand["agent"]>().toEqualTypeOf<
      | {
          mcpServers?: AgentMcpServerInput[];
          tools?: AgentToolInput[];
        }
      | undefined
    >();
  });
});
