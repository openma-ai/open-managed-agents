# Phase 0 SDS：原生委派移植 Node + Feishu Gateway 骨架

**Date**: 2026-08-12
**Status**: Draft v2 for engineering review（纯设计 SDS，未动 core、未 commit）

> 前置：[feishu-session-lifecycle.md](./feishu-session-lifecycle.md)（定稿）、
> [feishu-multi-agent-integration-prd.md](./feishu-multi-agent-integration-prd.md)、[secrets-design.md](./secrets-design.md)。
> 本 SDS 落实生命周期 §9.4 的 8 项 Node 移植要求 + §9.5 Gateway 自持结构。**v1 评审发现 5 个实现级阻断点，
> 已在本版修正（见 §12 changelog）。评审通过后才进入编码（TDD）。**

---

## 0. Context（为什么做这件事）

n=24 采样证明「永久角色 Session」跑法会让 Supervisor 主线程上下文随群龄增长 → P95 随群龄上升 →
活跃群击穿 120s SLA。生命周期文档定下解法：**事件级 Supervisor Session + Memory 沉淀 + 专家子线程**。

当前实现（`spikes/feishu-triage`）是 throwaway：手动 `POST /v1/sessions/:id/messages` × 3 伪造多专家并行，
没有用 OMA 原生 `call_agent_*`，也没有 Feishu Gateway/事件状态机/确认通道。Phase 0 把这套机制落到产品代码：
(1) Node 原生委派；(2) Feishu Gateway 骨架；(3) 四张表 + Memory 确认写入通道。

研究结论：Node 与 CF **共享同一套 harness**（`apps/main-node/src/index.ts:58-62` import
`@open-managed-agents/agent/harness/*`），harness 已认识 `call_agent_*`（`apps/agent/src/harness/default-loop.ts:61-74,169-181`）。
但 v1 评审确认：工具是在 `buildTools` 阶段（早于 `buildHarnessContext`）捕获 executor 的，所以接线点、
中断链路、Memory 契约、WS 生命周期都需要显式设计——不能照搬 CF。

---

## 1. 范围

**In Phase 0：**
- Node `delegateToAgent` 闭包（**落 `buildTools` 阶段**，§3.2）+ 子线程 + 单层委派强制（§3.3）；
- **Node 主 turn `AbortController` + `SessionStateMachine.interrupt()` + 父信号向子 harness 传播**（§3.6）；
- `packages/feishu` provider + **WS 长连接生命周期管理器**（§4.5，net-new，非镜像 Slack）；
- 四张新表（§5）：`session_threads` / `group_events` / `feishu_message_events` / `memory_confirmations`；
- `submit_pending_conclusion` 受控工具 + **requires-action 握手**（§6.2）；
- Node 侧补两处接线：`aux_model`、`platformReminders`（委派前置依赖）；
- api-types 同步：`session.thread_created` 加 `parent_thread_id`（§5.1）；
- TDD：单元 + 集成（拆为「Node 原生委派集成」与「Feishu 生命周期 E2E」两段，§7/§8）。

**Deferred：**
- 单子线程定向 `user.interrupt`（Phase 0 中断粒度=「整个事件」，§3.6）；
- 滑窗摘要（生命周期 §5）；CF Feishu 对等（PRD 一期 Node-only）；真实飞书 e2e 采样（签发闸，单独）；
- 可观测仪表盘（§8 指标先埋点）；多副本 leader-election（§4.5，一期单副本）。

---

## 2. 架构总览

```
飞书 WebSocket
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ packages/feishu (new provider) + FeishuWsManager (main-node) │
│  WS manager(start/stop/reconnect/dedup) → provider 内:       │
│   dedup(feishu_message_events) → 事件边界分类器(启发式+aux)  │
│   → 生命周期驱动(group_events 状态机)                        │
│   → POST /v1/sessions/:id/messages (Supervisor 跑)           │
│   → requires-action 握手收 submit_pending_conclusion         │
│   → 人工/规则确认后经 Memory REST+CAS 写                     │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ apps/main-node（原生委派 + 中断已补齐）                       │
│  Supervisor turn (sthr_primary) + 主 turn AbortController     │
│   └─ harness.run → 并行 call_agent_{sre,network,security}     │
│       └─ delegateToAgent 闭包(buildTools 阶段捕获)            │
│            → harness.run(subCtx, parentAbortSignal)           │
│            每 sthr_*：独立 InMemoryHistory，共享 sandbox，    │
│            子配置 callable_agents 已清空(单层)，              │
│            thread 标记广播，不碰 activeTurnId                  │
│  Supervisor 调 submit_pending_conclusion → custom_tool_use    │
│   → session requires_action 暂停 → Gateway 握手(§6.2)        │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. 设计 (A)：Node 原生委派移植

### 3.1 关键洞察（评审已确认成立）

`SessionStateMachine.activeTurnId` 是单标量（`packages/session-runtime/src/machine.ts:117`），`runHarnessTurn`
在 :149 设/:182 清，重入会 clobber 父 turn。CF 的 `runSubAgent`（`apps/agent/src/runtime/session-do.ts:3883-4148`）
本就**绕过主 turn 状态机**，直接 `harness.run(subCtx)` 嵌在父 turn 的工具执行阶段。Node 照搬：
**`delegateToAgent` 闭包直接 `harness.run(subCtx)`，不调用 `runHarnessTurn`，不碰 `activeTurnId`。**
三专家并行 = Supervisor 单 turn 内并行 `call_agent_*` tool-call 的自然结果（AI SDK 同轮多 tool_call 走 `Promise.all`）。

### 3.2 【阻断 #1 修正】闭包必须落 `buildTools` 阶段，且需扩 Registry 接口

`call_agent_*` 在共享 `buildTools` 里构造时就捕获 `env.delegateToAgent`
（`apps/agent/src/harness/tools.ts:1204,1208` 的 execute 闭包）。Node 的 `deps.buildTools`
（`apps/main-node/src/index.ts:560-567`）由 `SessionStateMachine` 在 `machine.ts:169` 调用，**早于**
`buildHarnessContext`（:171）。所以「只在 buildHarnessContext.env 加闭包」无效——工具那时已构造完，会返回
`"Multi-agent delegation not available: no thread executor configured"`（tools.ts:1204-1205）。

**修正：扩 `buildTools` 接口，但保持共享状态机边界干净。** 关键约束：**不要让通用
`SessionStateMachine` 接触 `eventLog/hub/loadAgent/resolveModel` 等 Node 专属对象。** 这些静态依赖由
Registry 包装层闭包捕获，状态机每 turn 只额外拿到动态的 `{ abortSignal }`：

- **Node 侧（Registry 包装层，`registry.ts:267` 构 machine 处）**：在闭包里捕获静态依赖
  `{ sessionId, tenantId, eventLog, hub, loadAgent, resolveModel, sandbox }`，组合出 `delegateToAgent` 闭包
  （§3.4），再把「带 delegateToAgent 的 env」注入共享 `buildTools`。全部封在 Registry 包装层，状态机看不到。
- **共享状态机侧（`machine.ts:169`）**：`deps.buildTools` 签名从 `(agent, sb)` 扩为 `(agent, sb, turnCtx)`，
  其中 `turnCtx = { abortSignal }`——**仅此一项动态字段**。`runHarnessTurn` 每 turn new 出 AbortController
  后把 `{abortSignal: controller.signal}` 传进去（与 §3.6 中断链路同一 controller）。
- 结果：通用 `SessionStateMachine` 只新增一个 `{abortSignal}` 入参，**不引入任何 Node 专属依赖**；
  `delegateToAgent` 闭包用 `turnCtx.abortSignal` 作为父信号传给子 harness（§3.4-6 / §3.6）。

### 3.3 【阻断 #1 修正】单层委派强制——清空子配置 callable_agents

v1 写的「不传 `delegateToAgent` ⇒ 子 tools 不含 `call_agent_*`」**不成立**：注册条件是
`callable_agents?.length && ANTHROPIC_API_KEY`（tools.ts:1194），**不要求 executor**；子 agent 若自身配了
`callable_agents`，工具照样注册，只是调用时报 unavailable。

**修正（Node-local，不动共享 tools.ts 条件以免影响 CF）：** `delegateToAgent` 闭包在构造子 tools 前，
**对子 agent 配置做不可变拷贝并清空 `callable_agents: []`**，再传给共享 `buildTools`。于是
`call_agent_*` 注册条件（`callable_agents?.length`）不满足，子线程根本看不到委派工具——单层强制由构造保证。
叠加：子 env 不传 `delegateToAgent`（双保险）。

> 注：CF 的**具名**子 agent 实际允许嵌套委派（只有合成 "general" 是单层）。因此「Node 单层」是**飞书产品决策**，
> 不是「镜像 CF 行为」——v1 此处表述错误，已改。

### 3.4 `delegateToAgent` 闭包职责（镜像 CF `runSubAgent`）

1. 生成 `sthr_*` threadId；
2. 解析子 agent 配置：`loadAgent(agentId)`；若 not found 返回 `"Sub-agent error: agent not found"`；
3. **不可变拷贝 + 清空 `callable_agents`**（§3.3）；
4. 插 `session_threads` 行 + 广播 `session.thread_created`（带 `parent_thread_id`，§5.1）；
5. `new InMemoryHistory()`（`apps/agent/src/runtime/history.ts:843`），首条 `user.message` = 委派 message；
6. 构造 subCtx：子 agent + 子 tools（§3.3，无 delegateToAgent）+ 共享 sandbox + 子 model + thread 标记广播
   （§3.5）+ **`runtime.abortSignal = turnCtx.abortSignal`**（§3.6）；
7. `harness.run(subCtx)`，取 assistant 文本返回；抛错 catch → `"Sub-agent error: …"`（tools.ts:1209 契约）。

### 3.5 线程标记广播（落点：`apps/main-node/src/lib/node-harness-runtime.ts:106-122`）

`NodeHarnessRuntime.broadcast` 当前不盖 `session_thread_id`。子线程广播需 stamp `session_thread_id: threadId`
并镜像到父事件日志（镜像 CF session-do.ts:4094-4101）。`session_events.session_thread_id` 列已存在
（`packages/event-log/src/sql` :314/:330-332），当前无人写非空值。

### 3.6 【阻断 #3 修正】中断链路——Phase 0 必须新建，非「已工作」

v1 把 `SessionRegistry.interrupt` 当工作父级 abort，错。实测：`registry.ts:188-204` 只 try 机器上**可选的**
`interrupt/abortInFlight`；`grep packages/session-runtime/src/machine.ts` 无任何 `interrupt/abort/AbortController`
匹配——**`SessionStateMachine` 这两个方法不存在**，注释明写「P3 wires the actual abort plumbing」。

**Phase 0 任务 3 必须新建全部中断链路：**

1. **主 turn AbortController**：`SessionStateMachine` 持有当前 turn 的 `AbortController`（`runHarnessTurn`
   开头 new，存入字段）；
2. **`runtime.abortSignal`**：把 controller.signal 经 `buildHarnessContext` 注入 `HarnessContext.runtime.abortSignal`
   （interface 已有此字段，agent 3 确认）；
3. **`SessionStateMachine.interrupt()`**：abort 当前 controller；registry.ts:196 的 `m.interrupt()` 真正生效；
4. **父信号向子 harness 传播**：`delegateToAgent` 闭包把 `turnCtx.abortSignal` 作为子 `harness.run`
   的 abortSignal（§3.4 第 6 步）→ 中断 Supervisor turn 即连带中止全部 in-flight 子线程；
5. **finally identity-safe 清理**：`runHarnessTurn` finally 里清 controller 字段，防重入误清内层 controller
   （镜像 CF session-do.ts 注释的 identity guard）。

完成后 §7.2 中断集成测试才能过。

### 3.7 用量统计（决定：落 `session_threads` 本表）

`reportUsage` 加线程维度。**决定**：`session_threads` 加 `input_tokens`/`output_tokens`，**`BIGINT NOT NULL
DEFAULT 0`**（非空、零起步），turn 结束累加。**累加必须用 DB 原子表达式**
（`UPDATE session_threads SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE …`），
**禁止 read-modify-write**（并发子线程 + PG 会丢更新）。不另起用量表。（v1 §3.4 未拍，本版定。）

### 3.8 Node 侧另两处接线（委派前置依赖）

- **`aux_model`**：`resolveNodeModelCreds`（index.ts:490）只解析主模型；`buildTools`（index.ts:562）没传
  `auxModel`。补：解析 `agent.aux_model` 并传入 `buildTools({auxModel, auxModelInfo})`。事件分类器依赖它。
- **`platformReminders`**：`buildHarnessContext`（index.ts:572）不设。CF 在 session-do.ts:4419-4461 从
  `session_memory_stores` 构造 Memory 提示。Node 镜像这段（读绑定 → 取 store 元数据 → 拼
  `/mnt/memory/<name>/ (access)` → push 进 platformReminders）。§6.3 群记忆只读注入依赖它。

### 3.9 8 项要求追溯

| 要求 | 落点 | 状态 |
|---|---|---|
| 1 每次委派生成唯一子线程 | §3.4-1 | 本 SDS |
| 2 独立子线程历史 | §3.4-5 | 本 SDS |
| 3 `parent_thread_id` 结构血缘 | §5.1 `session_threads` + api-types 同步 | 本 SDS |
| 4 `parent_event_id` 事件因果 | harness 已发 default-loop.ts:61/169 | 已就绪 |
| 5 同级专家并行 | §3.1 | 已就绪 |
| 6 子线程级中断/状态/用量 | §3.6（中断父级传播，定向 deferred）+ §3.7（用量）| 本 SDS |
| 7 Supervisor 事件级生命周期 | §4 provider 驱动 + §5.2 | 本 SDS |
| 8 Gateway 控制 Memory 确认写入 | §6 + §5.3 | 本 SDS |

---

## 4. 设计 (B)：`packages/feishu` provider + WS 管理器

### 4.1 落位与注册

新包 `packages/feishu`。注册：`packages/integrations-core/src/domain.ts:6` 的 `ProviderId` 加 `"feishu"`；
实装 `IntegrationProvider`；挂进 `apps/main-node` install-bridge + integrations 路由
（`apps/main-node/src/index.ts:1040-1075`、`:1186-1214`）。**一期在 Node 进程内，不另起 app**。

### 4.2 复用 Slack 模式的部分（仅 webhook/install 维度）

Slack 的 `slack_thread_sessions`/`slack_webhook_events`（`0000_consolidated.sql:605-627`）+ `scopeKeyFor()`
（`packages/slack/src/provider.ts:158`）+ `SessionGranularity`（domain.ts:213-278，用 `"per_event"`）——这些
**表结构 / scope 模型可借鉴**。但 **Slack 是 HTTP webhook，无长连接范本**（见 §4.5）。

### 4.3 provider 内部组件

1. WS 接收（§4.5 管理器）；
2. 去重：`feishu_message_events(delivery_id PK)`；
3. 事件边界分类器：启发式 → `aux_model` 兜底 → 失败默认 `new`（依赖 §3.8 aux 接线）；
4. 生命周期驱动：查 `group_events` → new 建 Supervisor Session（绑群 Memory `read_only`，§6.3）/ follow-up
   续 / reopen 新建（种子=旧事件 `seed_summary` + 群 Memory 读）；
5. **`submit_pending_conclusion` 握手**收结论（§6.2，**不经 SSE 文本解析**）；
6. 确认后 Memory REST + CAS 写（§6.4）。

### 4.4 Supervisor → 专家原生委派

Supervisor agent 配 `callable_agents=[sre,network,security]`；跑起来调 `call_agent_*`——现可用（§3 已接）。
**spike 手动扇出整段删除**。

### 4.5 【阻断 #5 修正】WS 长连接生命周期——net-new，非镜像 Slack

`IntegrationProvider`（`packages/integrations-core/src/provider.ts:146-157`）只有 install/webhook/mcp，**无
start/stop/reconnect**；Slack 走 `handleWebhook`。Feishu WS 长连接无现成范本，必须独立设计：

**持有方**：main-node 进程内新组件 `FeishuWsManager`（`packages/feishu/src/ws-manager.ts`），**不扩展**
`IntegrationProvider` 接口（WS 生命周期 ≠ 请求/响应语义；硬塞 start/stop 进 provider 会污染所有 provider）。
main-node bootstrap 时启动 manager，按 Feishu 安装实例建连。

**必须覆盖：**
- **多安装**：一个 Feishu app 安装 = 一条 WS 连接（按 app_id+tenant）；manager 维护连接表。
- **启动恢复**：进程启动按已安装实例表重连；指数退避（如 1s→30s 上限）。
- **凭据更新**：app_secret 经 Tier 1 env 注入（[secrets-design.md](./secrets-design.md)），重连时复用；
  凭据轮换需支持热更新（manager 监听配置变更）。
- **重复连接防护**：Feishu 单 app 仅允许一条活动长连接，后连踢先连——靠此 + `feishu_message_events`
  去重使重连/重复投递幂等。
- **shutdown**：main-node SIGTERM → manager 优雅关连接、drain in-flight。
- **多副本**：>1 main-node 副本会各开连接互相踢。**一期单副本是部署硬前提**（非「风险提示」——单副本不
  满足则 WS 网关不能正常工作）；多副本 leader-election（只 leader 持 WS）作为 deferred 加固项，部署清单与
  运维 runbook **强制标注**。

> §10 风险表登记：**单副本是一期部署硬前提**；WS 生命周期 + 多副本单消费者是多副本场景的前置约束。

---

## 5. 设计 (C)：数据结构（四张表）

新表进 `apps/main-node/migrations/`（PG），schema 源加在 `packages/db-schema/src/node-pg/` 并导出，镜像到
`node-sqlite`。**CF D1 不动**（一期 Node-only）。

### 5.1 【阻断 #2 修正】`session_threads`（复合主键 + 自引用外键）

v1 的 `id TEXT PK` 在共享 DB 下第二个 Session 的 `sthr_primary` 即冲突（CF 用 id PK 是因为每 DO 独立 SQLite）。

```
session_threads(
  id              TEXT NOT NULL,           -- sthr_primary / sthr_*
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  agent_name      TEXT,
  parent_thread_id TEXT,                    -- 结构血缘；sthr_primary 为 NULL
  input_tokens    BIGINT NOT NULL DEFAULT 0,  -- §3.7 用量累计；DB 原子累加，禁 read-modify-write
  output_tokens   BIGINT NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  archived_at     INTEGER,
  PRIMARY KEY (session_id, id),             -- 复合主键
  FOREIGN KEY (session_id, parent_thread_id)
    REFERENCES session_threads(session_id, id) ON DELETE CASCADE  -- 同 Session 内自引用
)
```
- **外键删除行为**：`session_threads` 是 Session 的 owned 子表 → `session_id` `ON DELETE CASCADE`
  （镜像既有 `account/session.userId→user ON DELETE cascade` 约定，`0000_consolidated.sql:629-630`）；
  自引用 `parent_thread_id` 同样 CASCADE。
- **`sthr_primary` 落行时机 = 懒插入（v2.2 #1 定稿，推翻 v2.1「同事务装饰层」主方案）**。理由：Session 原子
  事务封在 `SqlSessionRepo.insertWithResources`（`sql-session-repo.ts:49-82`，session+resources 封进
  `atomicWrite`），**外层装饰层无法加入这个内部事务**；`SessionRouter.init` 又在 Session 创建完成后才调——
  真同事务须侵入共享 sessions-store 或新增 Node 专属事务路径，成本/耦合不值得。落法：(a) `SessionRegistry.build`
  幂等插 `sthr_primary`（首次 runtime materialize 时落，`INSERT OR IGNORE`/`ON CONFLICT DO NOTHING`）；
  (b) `listThreads` 无记录时**合成** `sthr_primary`（API 诚实——primary 是概念上始终存在的线程）；
  (c) 首个子线程创建前保证 primary 行存在。子线程在 `delegateToAgent` 闭包内写。
- **api-types 同步**：`session.thread_created` 当前公共类型无 `parent_thread_id`
  （`packages/api-types/src/types.ts:519`）；CF 已在事件里发该字段（session-do.ts:3981）。Phase 0 把它加进
  api-types 公共 `SessionThreadCreatedEvent` + SDK，作为正式 SSE 契约。

### 5.2 `group_events` + `feishu_message_events`（事件/群→Session + 去重）

```
group_events(
  event_id              TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  group_id              TEXT NOT NULL,        -- 飞书 chat_id
  supervisor_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,  -- 保留历史业务记录
  status                TEXT NOT NULL CHECK(status IN('pending','discussing','synthesizing','concluded','failed')),
  seed_summary          TEXT,                 -- reopen 注入用
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  concluded_at          INTEGER,
  UNIQUE(tenant_id, event_id, group_id)       -- 复合 FK 目标：DB 强制租户+群归属（v2.2 #3）
)
feishu_message_events(
  delivery_id   TEXT PRIMARY KEY,             -- 飞书 message_id，去重 + WS 重投幂等
  tenant_id     TEXT NOT NULL,
  group_id      TEXT NOT NULL,
  event_id      TEXT,                         -- 去重骨架阶段可空（事件边界分类前）；分类后回填
  event_type    TEXT,
  received_at   INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, event_id, group_id)
    REFERENCES group_events(tenant_id, event_id, group_id)
    -- MATCH SIMPLE（PG 默认）：event_id 为 NULL 时 FK 不校验；回填后强制租户+群一致
)
```

### 5.3 【含握手幂等键 + 重试字段】`memory_confirmations`（业务确认状态）

```
memory_confirmations(
  confirmation_id     TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,            -- Gateway 业务表，租户自持；不跨表推导
  source_session_id   TEXT NOT NULL,            -- 审计来源：纯文本快照 ID，不建 sessions 外键
                                                 -- （审计记录须存活于被审计 Session 删除之后；v2.2 #2）
  custom_tool_use_id  TEXT NOT NULL,            -- 与 user.custom_tool_result 字段同名，降映射歧义
  event_id            TEXT NOT NULL,
  group_id            TEXT NOT NULL,
  memory_store_id     TEXT NOT NULL,
  memory_path         TEXT NOT NULL,
  memory_etag         TEXT,                     -- 写入 Memory 成功后的 CAS etag
  status              TEXT NOT NULL CHECK(status IN('pending','confirmed','rejected','superseded','retrying')),
  confirmer_type      TEXT CHECK(confirmer_type IS NULL OR confirmer_type IN('user','system')),
  confirmer_id        TEXT,                     -- pending 时无确认者，可空
  payload             TEXT,                     -- submit_pending_conclusion 的结构化 JSON
  last_error          TEXT,                     -- §7 降级重试用
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  next_retry_at       INTEGER,
  created_at          INTEGER NOT NULL,
  confirmed_at        INTEGER,                  -- pending 时为空
  UNIQUE(source_session_id, custom_tool_use_id),-- 握手幂等：同 custom_tool_use_id 不重复落
  FOREIGN KEY (tenant_id, event_id, group_id)
    REFERENCES group_events(tenant_id, event_id, group_id),  -- DB 强制租户+群一致（v2.2 #3）
  CHECK (                               -- status='confirmed' ⇒ 确认字段完整（PG+SQLite 原生 CHECK）
    status <> 'confirmed'
    OR (confirmer_type IS NOT NULL AND confirmer_id IS NOT NULL AND confirmed_at IS NOT NULL)
  )
)
```
> 业务确认状态 ≠ Memory 的 `redacted/version`（后者纠错/审计，`packages/memory-store/src/types.ts:40-54`）。
> `status` 含 `retrying` + `last_error/attempt_count/next_retry_at` 支撑 §7 降级「Memory 写失败标重试」。
> `confirmer_*`/`confirmed_at` 可空——`pending` 行刚落时尚无确认者；**内联 `CHECK`**（PG+SQLite 原生支持，
> v2.2 修正：不再用触发器）保证 `confirmed` 时三字段完整；`status`/`confirmer_type` 各加枚举 CHECK。
> **租户一致性由 DB 复合外键强制**（`FOREIGN KEY (tenant_id,event_id,group_id) REFERENCES group_events`），
> 不再靠「应用层校验 + 索引」（v2.2 #3：应用层一处漏 predicate 即可跨租户串关联）。
> `source_session_id` **不建 sessions 外键**——审计来源须存活于被审计 Session 删除之后（v2.2 #2）。

---

## 6. 设计：结论提交握手 + Memory 确认写入通道

### 6.1 【阻断 #4 修正】Memory REST 契约——actor 服务端推导，不可请求体伪造

v1 写「Gateway 传 user/system actor + Memory metadata」**与现契约不符**。实测
`packages/http-routes/src/memory/index.ts:120-145`：body 只收 `{path, content, precondition?}`；actor 服务端
固定 `{type:"user", id: c.var.user_id ?? c.var.tenant_id}`（:139）；**MemoryRow 无 metadata 字段**。

**收口：**
- **审计 actor 由服务端从 `oma_*` API key 推导**（解析出的 tenant_id / user_id），**禁止请求体任意声明
  actor**。⚠️ **但当前 REST 只能证明租户级 API 调用来源**——它把 API-key 请求记 actor=`user`，缺 `user_id`
  时用 `tenant_id`，**无法区分「Feishu Gateway key」与同租户其它 key**。因此 v2 写的「Gateway 服务身份即
  Memory 审计身份」**不准确**，已删。准确表述：(a) Memory version actor 当前仅能证明**租户级** API 调用
  来源；(b) Gateway / 确认人 / 事件来源的精确审计以 `memory_confirmations` 为准（`tenant_id` +
  `source_session_id` + `event_id` + `custom_tool_use_id`）；(c) 独立的 **API-key actor identity**（区分
  gateway vs 其它 key）**后续另立项**，不在 Phase 0。
- **业务字段（confirmer / event_id / group_id / source_session_id / tenant_id）存在 `memory_confirmations`**
  （§5.3）；如需随 Memory 行携带，**作为 Memory `content` 里的结构化 envelope**（JSON），**不新增 Memory
  metadata 列**。
- **若将来要 Memory 行级 metadata，单独立项**（schema + REST 契约变更），Phase 0 不做。

### 6.2 `submit_pending_conclusion` 受控工具 + requires-action 握手（开放点定稿）

不让 Supervisor 持 DB/Memory 写权限，改为严格 JSON Schema 的 custom tool：

1. Supervisor 调 `submit_pending_conclusion(payload)` → 产生 `agent.custom_tool_use`；
2. Session 以 `requires_action` **暂停**——语义来源是「**无 `execute` 的 custom tool**」本身
   （`tools.ts:1085-1089` 注册时不带 execute，注释 "handled by the client"），**不是** `always_ask`
   （那是另一套机制，勿混）。前提：§6.2.1 的 Node requires-action 恢复链已就绪；
3. Gateway 校验：工具名、`source_session_id ↔ event_id ↔ group_id` 三元绑定、payload schema；
4. Gateway 以 `custom_tool_use_id` 为**幂等键**，事务性 `INSERT memory_confirmations(status='pending')`
   （`UNIQUE(source_session_id, custom_tool_use_id)` 防重复）；
5. Gateway 回送 `user.custom_tool_result`（成功 ack），Supervisor 正常收尾、Session `CONCLUDED`；
6. 人工 `@confirm` 或规则（≥2 专家一致）确认后，Gateway 才经 Memory REST + CAS 写入（§6.4），并更新
   `memory_confirmations(status='confirmed', memory_etag=…)`。

这样既不依赖 SSE 文本解析（v1 开放点的顾虑），也不把 Memory/DB 写暴露给 Supervisor。

### 6.2.1 【新 P1】Node custom-tool requires-action 恢复链（前置任务）

v2 假设「Node 已支持 custom tool pause/resume」，**事实不是**。源码确认（v2.1 评审）：

- custom tool 注册**不带 execute**（`apps/agent/src/harness/tools.ts:1085-1089`，注释 "handled by the client"）；
- Node `NodeHarnessRuntime.pendingConfirmations` 声明为可选且**构造函数从未初始化**
  （`apps/main-node/src/lib/node-harness-runtime.ts:70,86-89`）；
- Node turn 完成后**固定发** `session.status_idle{stop_reason:{type:"end_turn"}}`
  （`node-session-router.ts:103-106`），无 requires_action 分支；
- Router **只对 `user.message` 启动 harness**（`node-session-router.ts:73`）；`user.custom_tool_result` 只
  `appendAsync`+publish（:68-71），**不会恢复 turn**。

因此 `submit_pending_conclusion` 不能只做成 Gateway 握手——必须先把 Node 的 custom-tool 暂停 / 持久化 /
校验 / 恢复链补上。**独立前置任务（任务拆解中排在 §6.2 握手实现之前，任务 6）：**

1. `NodeHarnessRuntime` 初始化 `pendingConfirmations`（pending `custom_tool_use_id` 集合）；
2. harness turn 遇 pending custom tool 时发 `requires_action`（带 `custom_tool_use_id`），**而非** `end_turn`
   （改 `node-session-router.ts:103-106` 的硬编码 stop_reason）；
3. **持久化 = `session_events` 派生，唯一真相源（v2.2 #4 定稿，推翻「旁表或 session_events」二选一）**：
   - pending 定义 = `agent.custom_tool_use` 事件中**尚无匹配** `user.custom_tool_result.custom_tool_use_id`
     的那些；**不新增第五张表**；
   - 进程重启后从事件日志**重建** pending 集合（与 append-only event log + crash recovery 模型一致）；
   - 接收 result 时在**同一 Session 内**验证对应 `agent.custom_tool_use` 存在且未被消费；
   - **不保存第二份 payload 状态**——恢复 turn 直接用完整事件历史，避免旁表与事件日志双写漂移。
4. Router 对 `user.custom_tool_result`：校验 `custom_tool_use_id` 命中 pending → 恢复 harness turn
   （`node-session-router.ts:59-117` 当前只驱动 `user.message`，需扩 `user.custom_tool_result` 分支）；
5. 防重复结果（同 id 二次 result → **409**）+ 防错误 id（无对应 pending → **400/409**）；
6. **重启后恢复测试**：进程挂掉重启，从事件日志重建的 pending 仍可被确认/恢复或安全超时收口。

> **事件日志是 pending 的唯一真相来源**（与 §6.2 握手的 `memory_confirmations` 业务确认记录分离：harness
> pause/resume 走事件日志；Gateway 业务确认审计走 `memory_confirmations`；两者以 `custom_tool_use_id` 关联）。
> CF 走 client（前端）侧 requires-action；Node 是服务端自循环，恢复链要自己实现。任务 8（握手实现）依赖
> 本任务完成。

### 6.2.2 已发现两个 Node recovery 缺陷（任务 6 必修，v2.2 评审）

§6.2.1 落实时必须顺手修这两处现成 bug，否则 pending 派生模型在重启后会错配/残留：

1. **`recovery.ts:113-114` 字段错配**：`case "user.custom_tool_result": if (ev.id) resolved.add(ev.id);`
   用的是结果事件自身的 `ev.id`，但真正指向 `agent.custom_tool_use` 的字段是 **`ev.custom_tool_use_id`**
   （对照 :108 tool_result 用 `ev.tool_use_id`、:111 mcp 用 `ev.mcp_tool_use_id`）。现状下结果永远匹配不上
   pending use → 重启后所有未消费 custom_tool_use 都被误判为「未解决」。**任务 6 改 `ev.id`→
   `ev.custom_tool_use_id` + 加重启恢复测试。**
2. **`user.custom_tool_result` 无 processed 标记路径**：`SqlEventLog`（`event-log/src/sql/index.ts:68,306-344`）
   把 `user.custom_tool_result` 写为 `processed_at=NULL`（pending 索引 `WHERE processed_at IS NULL … type IN
   (…'user.custom_tool_result')`，:343-344），但**成功恢复/消费后没有原子标记 processed 的路径** → pending 索引
   残留、可能重复恢复。**任务 6 补原子消费/标记**（恢复 turn 成功后 stamp `processed_at`，与 §6.2.1-3 事件
   日志单源一致）。

> 这两处是 §6.2.1 派生模型的现成债务；任务 6 一并修，不另起任务。

### 6.3 Supervisor 绑群 Memory（read_only）

provider 建 Supervisor Session 时，`POST /v1/sessions/:id/memory_stores`（`apps/main-node/src/index.ts:1264-1297`）
绑群 Memory store，**body `access:"read_only"`**。`access` → orchestrator `readOnly`
（`packages/sandbox/src/orchestrator.ts:139,198-214`）→ 能力达标 adapter（litebox/e2b）**OS 级只读强制**。
子线程共享 sandbox → 专家也只读。群记忆只读注入走 §3.8 `platformReminders`。

> ⚠️ `boxrun` 不做 OS 级只读（`adapters/boxrun.ts:220`）。处理不可信专家输出的部署须用 litebox/e2b。

### 6.4 Memory 写入（Gateway 服务身份，CAS）

确认后 Gateway 调 `POST /v1/memory_stores/:id/memories`：
- **首次创建**：`precondition:{type:"not_exists"}`；
- **覆盖已有路径**：`precondition:{type:"content_sha256", content_sha256:<上一版>}`；
- `content` = 结构化 envelope（结论 + confirmer + event_id + group_id + source_session_id + ts），actor 由服务端
  从 API key 推导；成功后 `memory_etag` 回填 `memory_confirmations`。
- 鉴权：`mintApiKeyOnStorage()`（`packages/http-routes/src/api-keys/index.ts:120`）签 `oma_*` key，`x-api-key` 头，
  `packages/auth/src/index.ts:65-72` 解析。无单独 service account。

---

## 7. TDD 计划（先测后码，覆盖率 ≥80%）

### 7.1 单元

- **`delegateToAgent` 闭包**（§3.4）：stub loadAgent + mock DefaultHarness → 断言：返回子 agent 文本；
  threadId 形如 `sthr_*`；`session_threads` 插行（复合 PK + parent 正确）；**子 tools 不含 `call_agent_*`**
  （callable_agents 已清空）；**子 env 无 delegateToAgent**；抛错返回 `"Sub-agent error: …"`。
- **buildTools 接线**（§3.2）：断言 Supervisor 的 `call_agent_*` 工具 execute 能调到 session 级闭包（非 unavailable）。
- **中断**（§3.6）：`SessionStateMachine.interrupt()` 触发主 controller abort；子 `harness.run` 收到 abort；
  finally identity-safe 清理；并发两个子线程中断不互相误清。
- **线程标记广播**：子线程事件 `session_thread_id === threadId`，镜像进父日志。
- **事件边界分类器**：纯函数 → new/follow-up/reopen + 失败默认 new。
- **submit_pending_conclusion 握手**：mock requires-action → 校验失败/通过两路；`UNIQUE(source_session_id,custom_tool_use_id)` 幂等；pending 派生自事件日志（§6.2.1-3）。

### 7.2 集成（拆两段，对齐任务重排）

**A. Node 原生委派集成**（= 任务 5，不依赖飞书；前置：任务 1-4）：
Supervisor `callable_agents=[3 experts]` → `POST /v1/sessions/:id/messages` → 断言：3 个 `sthr_*` 并发、
独立历史、Supervisor 收 3 份意见、`session_threads` 行齐全、`session.thread_created` 带 `parent_thread_id`；
中断：`user.interrupt` → Supervisor turn + 全部子线程中止。

**B. Feishu 生命周期 E2E**（= 任务 9，A 之上接 provider；前置：任务 6/7/8）：`group_events` 状态机、
`submit_pending_conclusion` 握手落 `memory_confirmations(pending)`、人工确认后 Memory 行存在且
`memory_etag` 回填、WS 重连靠 `feishu_message_events` 去重幂等。

**降级**：专家抛错→缺位继续；全挂→Supervisor 兜底；Memory REST 500→`memory_confirmations` 标 `retrying`+
`last_error/next_retry_at`、事件仍 `concluded`。

### 7.3 验收 = 生命周期 §10 的 6 条

集成 B 即生命周期验收闸：同事件两轮不丢上下文 / P95 不随群龄升 / Prompt 上限独立策略 / 跨事件召回 /
原始群聊不入库 / 失败仍完成事件。

---

## 8. 任务拆解（重排：A 段可先合，飞书在后）

1. **数据结构**：四张表 schema + 迁移（node-pg + node-sqlite）+ 迁移测试。**前置已解**：`memory_confirmations`
   的 `pending` 语义修过（`confirmer_*`/`confirmed_at` 可空 + status 约束，§5.3），现可诚实表达 pending；
   `tenant_id` 自持。
2. **Node 接线零碎**：`aux_model`、`platformReminders`（§3.8）——独立可测。
3. **中断链路**（§3.6）：主 turn AbortController + `SessionStateMachine.interrupt()` + abortSignal 注入 +
   finally 清理。单测先行。
4. **`delegateToAgent` 闭包**（§3.2-3.5）：buildTools 签名扩展（**machine 只收 `{abortSignal}`，Registry 闭包
   捕获静态依赖**）+ 闭包 + 单层强制 + session_threads 写入 + 线程标记广播 + thread_created + **sthr_primary
   落 `SessionRegistry.build` 懒插入**（§5.1，v2.2）。
5. **Node 原生委派集成测试**（§7.2 A 段）：直接 POST 给带 callable_agents 的 Supervisor，不经飞书验证。
6. **【新 P1 前置】Node custom-tool requires-action 恢复链**（§6.2.1 + §6.2.2）：`pendingConfirmations` 初始化
   + requires_action 分支（非 end_turn）+ 持久化 pending（事件日志派生）+ `user.custom_tool_result` 校验恢复
   + 防重/防错 id（409/400）+ 重启恢复测试 + **修 `recovery.ts:113-114` 字段错配** + **补 `processed_at` 原子消费标记**。
   > **1-6 可独立合并**（Node 侧：原生委派 + 中断 + custom-tool 恢复，完整可用，是交付主干；飞书在后）。
7. **`packages/feishu` provider + FeishuWsManager**（§4）：WS 生命周期 + 去重 + 分类器 + 生命周期驱动。
8. **`submit_pending_conclusion` 握手 + Memory 确认通道**（§6；**依赖任务 6**）。
9. **Feishu 生命周期 E2E**（§7.2 B 段）。
10. **删除 spike 手动扇出**，产品路径切原生委派。

---

## 9. 验证（端到端）

- **单测/集成**：`pnpm --filter @open-managed-agents/main-node test`。
- **手测 Node 委派（任务 4 后即可，不经飞书）**：直接 `POST /v1/sessions/:id/messages` 给带
  `callable_agents=[…]` 的 Supervisor，SSE 应出 `session.thread_created` ×3 +
  `agent.thread_message_sent/received` ×3 + Supervisor 综合（等同任务 5 集成测试的手测版）。
- **全链路（任务 9 后）**：`spikes/feishu-triage` sampler 改调产品路径，重跑 n=24，对照基线 P95 72.38s；
  预期事件级 Session 下 P95 回 ~33s 量级且不随群龄升（生命周期验收 #2）。
- **签发闸**（后置，非本 SDS）：一轮真实飞书 e2e。

---

## 10. 风险与开放问题

| # | 风险/问题 | 处置 |
|---|---|---|
| 1 | adapter 只读执法差异（boxrun 不强制）| 部署清单标注；不可信输出用 litebox/e2b |
| 2 | `aux_model` model card 是否就绪 | 部署前确认 `/v1/model_cards` 有 aux 卡；否则分类器降级纯启发式 |
| 3 | 子线程并发对 `NodeHarnessRuntime`/`SqlEventLog` 共享状态线程安全 | 子线程独立 InMemoryHistory + 独立 broadcast 包装；只读共享 sandbox；审查 SqlEventLog 并发 append |
| 4 | **单副本是一期部署硬前提**（§4.5）| 部署/runbook 强制；多副本 leader-election deferred、须先做 |
| 5 | Feishu 单 app 单活动连接，副本互踢 | 靠飞书机制 + `feishu_message_events` 去重幂等；多副本须 leader-election |
| 6 | `submit_pending_conclusion` payload schema 演化 | 严格 JSON Schema + 版本字段；校验失败→Gateway 拒、Supervisor 重发 |

---

## 11. 参考

- 生命周期定稿：[feishu-session-lifecycle.md](./feishu-session-lifecycle.md) §9
- Harness 共享：`apps/main-node/src/index.ts:58-62,568-571`；buildTools :560-567（需扩签名）
- `call_agent_*` 注册/捕获：`apps/agent/src/harness/tools.ts:1193-1215`（注册不要求 executor）、general_subagent :1224（要求 executor）
- `delegateToAgent` 接口：`apps/agent/src/harness/interface.ts:235`
- CF `runSubAgent` 模板：`apps/agent/src/runtime/session-do.ts:3883-4148`
- `activeTurnId`：`packages/session-runtime/src/machine.ts:117,141-185`（无 interrupt/abort——需新建）
- `SessionRegistry.interrupt`：`apps/main-node/src/registry.ts:188-204`（stub，依赖 machine.interrupt）
- `NodeHarnessRuntime`：`apps/main-node/src/lib/node-harness-runtime.ts:30-55,106-122`
- `session_events.session_thread_id` 已存在：`packages/event-log/src/sql` :314/:330-332
- sessions 表无 lineage：`packages/db-schema/src/node-pg/cf-auth-sessions.ts:6-37`
- `IntegrationProvider` 无生命周期：`packages/integrations-core/src/provider.ts:146-157`
- Slack 表范本（仅结构）：`0000_consolidated.sql:605-627`；`packages/slack/src/provider.ts:158`；domain.ts:213-278
- Memory REST 契约：`packages/http-routes/src/memory/index.ts:120-145`（actor 服务端固定 :139，无 metadata）
- 绑定路由：`apps/main-node/src/index.ts:1264-1297`
- Memory 服务 CAS：`packages/memory-store/src/service.ts:231-240,248-253`；types :56-58
- 鉴权：`packages/http-routes/src/api-keys/index.ts:120`；`packages/auth/src/index.ts:65-72`
- 只读执法：`packages/sandbox/src/orchestrator.ts:139,198-214`；boxrun 不强制 `adapters/boxrun.ts:220`
- `session.thread_created` 类型缺 parent_thread_id：`packages/api-types/src/types.ts:519`

---

## 12. v2 changelog（v1 评审 5 阻断 + 矛盾的处置）

**阻断（全部已改）：**
1. 闭包落点 `buildHarnessContext` → **`buildTools` 阶段 + 扩 Registry 接口**（§3.2）；单层强制「不传 executor」
   → **清空子配置 callable_agents（不可变拷贝）**（§3.3）。
2. `session_threads` `id TEXT PK` → **`PRIMARY KEY(session_id, id)` + 自引用外键 + sthr_primary 落行时机**
   （§5.1）。
3. 中断「已工作」→ **新建全链路**（主 AbortController + machine.interrupt + abortSignal 注入 + 父信号传播 +
   finally 清理）（§3.6）。
4. Memory actor/metadata 任意伪造 → **服务端从 API key 推导；业务字段进 memory_confirmations + content envelope；
   不新增 Memory metadata 列**（§6.1）；CAS 区分 not_exists/content_sha256（§6.4）。
5. 「镜像 Slack 生命周期」→ **WS 长连接 net-new，FeishuWsManager，多副本单消费者一期单副本 + leader-election
   deferred**（§4.5）。

**矛盾（已改）：**
- 表数「三张/两张」→ 统一**四张**（§1/§5）。
- 用量「落本表或用量表未定」→ **落 session_threads 本表**（§3.7/§5.1）。
- 降级「标 retry」无枚举/字段 → status 加 `retrying` + `last_error/attempt_count/next_retry_at`（§5.3）。
- `session.thread_created` 缺 parent_thread_id → **api-types 同步列为任务**（§5.1）。
- 「Node 单层镜像 CF」→ **改为产品决策**（CF 具名子 agent 可嵌套；飞书不允许）（§3.3）。
- 任务 4 无法在 provider 前验 group_events/memory_confirmations → **拆为 A 段（Node 委派集成）+ B 段（Feishu E2E，
  任务 8）**（§7.2/§8）。

**开放点定稿：** `submit_pending_conclusion` 走 **requires-action 握手**（§6.2），Supervisor 不持写权限，
`memory_confirmations` 加 `UNIQUE(source_session_id, custom_tool_use_id)` 幂等键（§5.3）。

**v2.1（v2 评审 2 新 P1 + 表结构 2 处 + 六项拍板细化）：**
- **【新 P1】Node custom-tool requires-action 恢复链**：v2 误以为 Node 已支持；实测 `pendingConfirmations` 未
  初始化、turn 固定 `end_turn`、`user.custom_tool_result` 不恢复 turn。新增前置任务 §6.2.1 + 任务 6。§6.2 删
  `always_ask` 表述（custom tool 无 `execute` 即语义）。
- **【表结构】`memory_confirmations`**：`confirmer_type/id/confirmed_at` 改可空 + status 约束（pending 无
  确认者）；加 `tenant_id`（Gateway 业务表自持租户，不跨表推导）+ 与 `group_events` 租户一致性；
  `tool_use_id` → `custom_tool_use_id`（与 `user.custom_tool_result` 同名，降映射歧义）。——解任务 1 阻塞。
- **【拍板细化 #1】sessionCtx 形状**：通用 `SessionStateMachine` 不接触 Node 专属对象；Registry 包装层闭包
  捕获静态依赖，machine 每 turn 只收 `{abortSignal}`（§3.2）。
- **【拍板细化 #3】sthr_primary 落点**：不在 `SessionRegistry.build`（懒加载）；改落共享 session-creation
  service/repository 装饰层、与 sessions 行同事务（§5.1）。
- **【拍板细化 #4】用量列**：`BIGINT NOT NULL DEFAULT 0`，DB 原子累加，禁 read-modify-write（§3.7/§5.1）。
- **【拍板细化 #5】审计文案**：删「Gateway 服务身份即 Memory 审计身份」；Memory version actor 仅证明租户级
  来源，精确审计以 `memory_confirmations` 为准，API-key actor identity 另立项（§6.1/§6.4）。
- **【拍板细化 #6】单副本**：升级为部署硬前提，非风险提示（§4.5/§10）。

**v2.2（v2.1 评审 3 数据结构阻断 + requires-action 真相源 + 文本残留）：**
- **【阻断】外键会阻断 Session 删除**：三列定 `ON DELETE`——`session_threads.session_id` CASCADE（owned 子表，
  镜像 `account/session→user cascade`，`0000_consolidated.sql:629-630`）；`group_events.supervisor_session_id`
  可空 + SET NULL（保留历史）；`memory_confirmations.source_session_id` **不建外键、保留纯文本快照 ID**（审计须
  存活于被审计 Session 删除之后）。任务 1 加 Session 删除迁移测试。
- **【阻断】租户一致性由 DB 强制**：`group_events` 加 `UNIQUE(tenant_id,event_id,group_id)` 复合键；
  `memory_confirmations` + `feishu_message_events` 用对应 `FOREIGN KEY(tenant_id,event_id,group_id)` 复合外键
  （`feishu_message_events.event_id` 去重骨架阶段可空，MATCH SIMPLE 下空值不校验、回填后强制）。删「应用层
  校验 + 索引」表述。
- **【阻断】sthr_primary 改懒插入**：推翻 v2.1「同事务装饰层」——`SqlSessionRepo.insertWithResources` 事务
  封死（sql-session-repo.ts:49-82），外层加不进。改：`Registry.build` 幂等补行 + `listThreads` 合成 primary +
  首子线程前保证存在（§5.1）。
- **【requires-action 真相源定稿】**：pending = `session_events` 派生（无匹配 result 的 `agent.custom_tool_use`），
  **不新增第五张表**；事件日志是唯一真相源，重启重建，不存第二份 payload。409 重 dup / 400|409 错 id（§6.2.1）。
- **【文本】**：§3.4/§3.6 `sessionCtx.parentAbortSignal` → `turnCtx.abortSignal`；§7.1 `tool_use_id` →
  `custom_tool_use_id`；§7.2/§9 任务编号对齐 v2.1（A=任务 5、B/全链路=任务 9、手测=任务 4 后）；§5.3 状态约束
  改内联 CHECK（PG+SQLite 原生，删触发器）+ `status`/`confirmer_type` 枚举 CHECK。
