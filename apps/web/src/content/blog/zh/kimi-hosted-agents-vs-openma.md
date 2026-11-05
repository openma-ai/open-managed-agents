---
title: "Kimi 托管智能体上线：Harness as a Service 和 OpenMA 怎么选"
description: "Kimi Hosted Agents 把 Agent Harness 做成云服务。和开源的 OpenMA 比，差在谁跑编排、模型能不能换、自托管到哪一层，以及迁移怎么做。"
publishedAt: 2026-11-05
lang: zh
author: openma
tags: ["kimi", "hosted-agents", "托管智能体", "harness-as-a-service", "comparison", "migration", "self-hosted", "byok"]
---

月之暗面提供的 Kimi Hosted Agents，中文叫「托管智能体」，官方的说法是 Harness as a Service。意思很直接：调模型、执行工具、存会话历史、出错接管这一整套 Agent 运行框架，由 Kimi 在云上替你跑，你只管配置 Agent、往会话里发事件（[产品概览](https://platform.kimi.com/docs/hosted-agents/overview)）。

OpenMA 做的是同一类事，只是方向反过来：运行时开源，可以自己部署，模型自己挑。这篇讲两者的差别，以及已经在 Kimi 上跑了一阵、想把部分 Agent 挪出来的话，迁移该怎么拆。

## 托管智能体里有什么

资源模型和 Claude Managed Agents 很像，名词基本能一一对上：

- **Agent** 是带版本的配置，包括模型、系统提示词、工具、MCP、技能、插件和可选的子智能体列表。会话创建时锁定当时的版本，之后改 Agent 不影响老会话。
- **Session** 创建出来是 `idle`，发一条 `user.message` 才开始跑。历史以事件形式存在服务端，通过 SSE 推送，断线后带游标续读（[事件流](https://platform.kimi.com/docs/hosted-agents/event-stream)）。
- **Environment** 描述云沙箱的依赖、网络和初始化脚本，每个会话一个独立沙箱。
- **Vault** 存第三方凭据，创建会话时绑定，MCP 凭据按服务地址匹配注入。
- **Skill** 是 `SKILL.md` 加资源的包，只读挂在 `/mnt/agents/skills/<name>/`。**Plugin** 把 MCP 和技能打成一包，官方插件按调用次数收费。
- 另外还有 `save_artifact` 产物、记忆库、自动整理记忆的「梦境」，以及定时触发器。

官方说开箱有 140 多个技能、30 多个插件、12 个 Agent 模板，金融场景占大头，也有游戏、SRE 和出海社群运营。

入口有三个：`kha` CLI（推荐，专门设计成给 Kimi Code、Claude Code、Codex 这类编程助手调用）、网页控制台，以及 `https://api.moonshot.cn/v1` 上的 REST + SSE，请求头带 `kimi-api-version: 2026-09-01-beta`。官方迁移指南明说不需要 SDK，curl 就能用（[迁移指南](https://platform.kimi.com/docs/hosted-agents/migration)）。

计费是三块相加：云沙箱每小时 ¥0.072，模型 token 按所选模型价格算，插件按次计费（[定价](https://platform.kimi.com/docs/pricing/hosted-agents)）。

## 对照表

| | Kimi 托管智能体 | OpenMA |
|---|---|---|
| Harness 谁来跑 | Kimi 平台 | 自己部署，或者用 OpenMA 托管版。Harness 开源，可以换 |
| 会话和事件 | 服务端事件日志，SSE 游标续读，需 `include_deltas=true` 的 `agent.delta` 增量输出 | 事件先落库再广播，SSE 或 JSON 轮询，Harness 崩了就重放日志接着跑 |
| 沙箱 | Kimi 云沙箱；企业认证用户可接自托管 Worker | 可插拔：Docker、E2B、Daytona、Modal、Cloudflare、OpenSandbox 等 |
| MCP / 技能 | 远程 MCP、`SKILL.md` 技能、收费官方插件 | 远程 MCP、技能、Vault 凭据在出站代理处注入 |
| 模型 | Kimi 模型 | 任意配了 Model Card 的厂商，包括 Kimi |
| 计费 | 云沙箱时长 + Kimi token + 插件次数；自托管 Worker 工具无平台执行费 | 自托管：自己的机器钱，token 直接付给模型厂商；托管版按沙箱算力（[价格](/pricing/)） |
| 「自托管」指什么 | 沙箱工具在你的机器上跑，编排、模型和会话还在 Kimi | 控制面、数据库、沙箱都在你选的基础设施上 |
| 客户端 | `kha`、控制台、Kimi 专有 REST | `/v1` 上的 Claude Managed Agents 形状 API、`/openai/v1` 上的 OpenAI Agents API 适配、`oma` CLI、控制台 |
| 源码 | 闭源服务 | Apache 2.0 |

## 「自托管环境」到底托管到哪

这一点最容易误读，单独说一下。

Kimi 的[自托管环境](https://platform.kimi.com/docs/hosted-agents/self-hosted-environments)是在你的主机上跑一个 Worker，主动去平台领工具调用，执行 `shell`、读写文件这类沙箱工具，再把结果交回去。Agent 循环仍然在云端跑，文档自己也写了，这不等于私有化部署，工具的输入和执行结果还是会经过平台的模型推理接口。另外在这个模式下 `ipython` 和 `save_artifact` 暂不支持，技能和记忆也不会挂到 Worker 主机上。这个功能目前只对企业认证用户开放。自托管 Worker 上的文件和 shell 工具不收平台执行费，主机由你提供；平台侧搜索工具仍按次计费，模型推理费用另计。

所以它解决的是「代码得在内网旁边跑」，前提是模型调用可以出去。如果要求连编排和会话历史都留在自己机房，那就是另一类方案了。

## 什么时候选 Kimi 托管智能体

- Agent 本来就跑 Kimi 模型，希望平台把重试、故障接管这些运维活全包了。
- 官方金融插件和模板刚好对口，按次付费比自己接一遍数据源划算。
- 已经有 Kimi 开放平台账号，想让运行时、token、插件都走同一个账户结算。
- 团队习惯让编程助手管基础设施，`kha install-skill` 就是为这个设计的。

## 什么时候选 OpenMA

- 想让不同 Agent 用不同模型，有的用 Kimi，有的用 Claude、GPT 或 DeepSeek，按 Agent 配。
- 会话历史、凭据、产出连同编排层都必须留在自己控制的数据库和网络里。
- 想读、改或者整个替换 Harness；或者想把 Kimi Code 本身通过 OpenMA 的 ACP 运行时放进托管沙箱里跑。
- 现有客户端已经说 Claude Managed Agents API 或 OpenAI Agents API，希望两种客户端打同一批会话。

## 从 Kimi 托管智能体迁到 OpenMA

先说清楚边界：OpenMA 不实现 Kimi Hosted Agents 的线协议，客户端的 HTTP 层要改。可以复用兼容的自定义工具 JSON Schema，以及不依赖平台的提示词和技能内容。

内置工具配置需要转换：Kimi 使用 `{"type":"agent_toolset","name":"default_toolset_20260901"}`，OpenMA 使用 `{"type":"agent_toolset_20260401"}`。工具名也要映射，例如 `shell` → `bash`、`read_file` → `read`、`web_open_url` → `web_fetch`。检查工具权限、技能中的路径和依赖，重新创建资源 ID 与凭据绑定，不能直接复制整份 Agent 配置（[Kimi 工具文档](https://platform.kimi.com/docs/hosted-agents/tools)）。

### 第一步：盘点

用 `kha` 或 REST 把现有资源导一遍：每个 Agent 的当前版本（模型、系统提示词、工具配置、MCP、技能、插件、子智能体列表）、环境、Vault 里的凭据类型、记忆库和触发器。重点标出依赖官方插件的 Agent，这部分在 OpenMA 没有现成对应物。

### 第二步：资源对上号

| Kimi 托管智能体 | OpenMA |
|---|---|
| Agent（带版本，会话锁版本） | Agent（同样带版本，会话锁版本） |
| Environment | Environment，加上部署时选定的沙箱 provider |
| `type: custom` 自定义工具 | 同名事件 `agent.custom_tool_use` / `user.custom_tool_result`，idle 时带 `stop_reason.event_ids` |
| `always_ask` 权限 + `user.tool_confirmation` | 同名策略和事件 |
| 远程 MCP + Vault（`static_bearer`、`mcp_oauth`） | 远程 MCP + Vault，同样这两种凭据 |
| 技能包 | 上传到 OpenMA 后挂到 Agent 上 |
| 记忆库 | 记忆库，挂在 `/mnt/memory/<store>/` |
| 协调智能体 + `spawn_subagent` | 父 Agent 上配 `multiagent.subagents.predefined_agents` |
| `save_artifact` | Agent 写到 `/mnt/session/outputs`，用 `GET /v1/sessions/:id/outputs` 取 |
| 触发器 | 自己的调度器定时调 API 建会话 |

预定义子智能体可以按下面的配置加入父 Agent 的创建请求，和 `name`、`model`、`system` 一起提交。把 `agent_researcher` 和版本 `1` 换成已存在的 OpenMA Agent 及其版本。这里仅启用名单中的子智能体；旧的 `callable_agents` 字段已不被托管运行时读取。

```json
{
  "multiagent": {
    "type": "multiagent_20261001",
    "advisor": {
      "type": "disabled"
    },
    "subagents": {
      "type": "enabled",
      "inline_agents": {
        "type": "disabled"
      },
      "predefined_agents": [
        {
          "type": "agent",
          "id": "agent_researcher",
          "version": 1
        }
      ]
    },
    "workflows": {
      "type": "disabled"
    }
  }
}
```

### 第三步：会话和事件

事件名大多一致，`user.message`、`user.interrupt`、`agent.message`、`agent.thinking`、`agent.tool_use`、`agent.tool_result` 两边都有。真正会让照搬代码出错的是结构差异：

- Kimi 的事件内容包在 `data` 里，比如 `{"type": "user.message", "data": {"content": [...]}}`；OpenMA 的 `content` 直接放在事件上。
- Kimi 的会话状态多了 `stopping`、`interrupted`，子智能体的事件用顶层 `session_thread_id` 区分线程。
- 续读机制不同，Kimi 用 `cursor` 和 `stream_cursor`。重连逻辑建议按 OpenMA 的事件流重写，别去转换游标。

Kimi 的 SSE 订阅还需加 `include_deltas=true` 才会收到 `agent.delta`。这些增量预览不保存在历史事件列表里，重放要使用持久化的完整事件（[事件流](https://platform.kimi.com/docs/hosted-agents/event-stream)）。

比较省事的做法是在自己的客户端里加一层很薄的转换（Kimi 事件进、OpenMA 事件出），这样两个后端可以并行跑一段时间，对比结果再切。

### 第四步：模型可以继续用 Kimi

离开 Kimi 的 Harness，不等于离开 Kimi 模型。OpenMA 底下的模型层自带 `moonshotai-cn` provider，指向 `https://api.moonshot.cn/v1`，建一张 Model Card 绑上你自己的 Moonshot API Key 就行：

```bash
curl -X POST "$OMA_BASE_URL/v1/oma/model_cards" \
  -H "x-api-key: $OMA_API_KEY" -H "content-type: application/json" \
  -d '{
    "model_id": "kimi",
    "provider": "moonshotai-cn",
    "model": "kimi-k3",
    "api_key": "'"$KIMI_API_KEY"'"
  }'
```

Agent 里写 `"model": { "id": "kimi" }`。内置目录里还没有的新模型，用 `base_url` 加 `pi_config.api: "openai-completions"` 建卡，见 [Model Cards 文档](https://docs.openma.ai/reference/api/#model-cards)。token 费用直接走你的 Moonshot 账户。

### 第五步：哪些带不走

- **官方插件**和背后按次收费的数据源。需要的话用自己的 MCP 或技能重建，或者这几个 Agent 先留在 Kimi。
- **梦境**。记忆库的文件能搬，自动整理搬不走，可以用一个定时跑的 Agent 去重写记忆库来替代。
- **Kimi Inference Hook**，企业定向开放的推理前安全检查。在 OpenMA 上，同类策略放在你自己的网关或 Harness 里。
- **平台沙箱价格**。¥0.072/小时是 Kimi 云沙箱的价，OpenMA 上的沙箱成本取决于你选的 provider 或自己的机器。
- **官方 Agent 模板**本身。模板页把提示词和技能讲得比较细，可以照着在 OpenMA 上重搭。

### `kha` 能不能直接指过来

`kha` 按 profile 记服务地址，也能用 `--base-url` 覆盖，看起来指到 OpenMA 就行。目前不行，因为 OpenMA 还不提供 Kimi Hosted Agents 的 API。兼容层我们在评估，做出来之前请用 `oma` CLI 或直接 HTTP。有进展会更新这篇。

## 接下来

动手的话从 [OpenMA 快速开始](https://docs.openma.ai/quickstart/)起步，沙箱 provider 怎么选见[中文沙箱文档](https://docs.openma.ai/zh-cn/sandboxes/)。另外两家托管 Harness 的对照在 [OpenAI Agents API vs OpenMA](/blog/openai-agents-api-vs-openma/) 和 [Claude Managed Agents vs OpenMA](/blog/claude-managed-agents-vs-open-managed-agents/)。
