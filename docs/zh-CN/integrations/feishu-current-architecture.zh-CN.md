# 飞书集成 — 当前架构

**状态**: 已上线,截至 2026-08-13 的代码快照。
**前置文档**: [`feishu-multi-agent-integration-prd.md`](../feishu-multi-agent-integration-prd.md)(PRD) 与 [`feishu-session-lifecycle.md`](../feishu-session-lifecycle.md)(会话策略)。本文是实现参考 — 前两篇讲产品/会话设计,本文讲真正落地的内容。

---

## TL;DR

飞书是一等公民的 OMA 集成 Provider,镜像 Slack 的 publication-first 安装模式。没有 OAuth — 安装是三步向导,用户粘贴四个密钥(App ID、App Secret、Verification Token、Encrypt Key)后,一次浏览器跳转即可完成。入站事件通过每个安装一条出站 WebSocket 长连接拉取,无需公网回调入口。每个飞书群(可配置为群+用户)映射到一个 OMA 会话,粒度按 publication 配置。

---

## 心智模型

```
                    飞书开放平台
                    ────────────
                          │
        WebSocket 长连接 ↓   ↑ REST (im/v1/messages)
        (每个安装一条)       │
                          │
       ┌──────────────────────┼──────────────────────────────────────┐
       │  apps/integrations (gateway worker)                        │
       │  ┌──────────────────────────┐  ┌─────────────────────┐    │
       │  │  WS runner (CF container)│  │  HTTP gateway       │    │
       │  │  每个安装一个             │  │  /integrations/feishu│    │
       │  │  解密 → 分派              │  │  /publications/*     │    │
       │  └─────────────┬────────────┘  └──────────▲──────────┘    │
       └────────────────│─────────────────────────│─────────────────┘
                        │ user.message             │ start-a1, credentials
                        ▼                          │
       ┌────────────────────────────────────────────────────────────┐
       │  apps/main (OMA)  →  apps/agent (SessionDO)                │
       │  数字人决定输出什么;会话范围按 per_chat / per_chat_user  │
       └────────────────────────────────────────────────────────────┘
```

两个通道,结构与 Slack 一致:
- **入站**(飞书 → 数字人):WebSocket 事件解密(或 verification-token 验签),归一化后,以 `user.message` 分派到数字人 OMA 会话,按 `(publicationId, scopeKey)` 绑定。
- **出站**(数字人 → 飞书):数字人调用飞书 MCP / HTTP 工具发送消息、编辑历史消息、加表情回应。

无自动镜像层。数字人内部的 `thought` / `tool_use` 事件保留在 OMA 内,除非数字人主动调用工具,否则不会到达飞书。

---

## 安装流程(publication-first)

安装是单一向导,用户粘贴密钥后一次点击即可完成。**没有** `installPersonalToken` 路径,**没有** handoff link,**没有** 两步 OAuth — 飞书开放平台本质是"自带机器人应用"。

```
1. Console 向导 PickStep
   → 选 agent + environment + persona + tenant_type(internal | external ISV)
   + session_granularity(per_chat | per_chat_user)
   POST /v1/integrations/feishu/start-a1
   → 服务端创建 `feishu_publications` 行(状态 = pending_setup),
   返回 `formToken`(用作 setup-link 密钥)

2. 用户粘贴 4 个密钥(App ID、App Secret、Verification Token、Encrypt Key)
   POST /v1/integrations/feishu/credentials
   → 服务端调用 getTenantAccessToken 校验(打 open.feishu.cn),
   用 WebCryptoAesGcm 加密 3 个密钥字段,
   状态 pending_setup → credentials_filled

3. Console 为新 `feishu_installations` 行启动 WebSocket runner。
   runner 首次成功(重)连并拉取一个事件后,
   状态翻转 awaiting_install → live。
```

状态机:`pending_setup → credentials_filled → awaiting_install → live → (unpublished | needs_reauth)`。`unpublished` 是终态。`needs_reauth` 在 WS runner 401 刷新失败时触发。

此流程无公网回调 URL — 飞书开放平台通过每个应用一条出站 WebSocket 推送事件,由 integrations worker 拨号。

---

## 租户类型

飞书将世界分为两类:

| `tenant_type` | 受众 | 说明 |
|---|---|---|
| `internal` | 在一个租户内发布 | Bot 创建在该租户的应用目录下;WS 以该租户的应用身份连接 |
| `external` | 作为 ISV(第三方 SaaS)发布 | 应用"对所有租户可见";每个租户独立安装,WS 用每个安装独立的 `tenant_access_token` 拨号 |

`feishu_installations` 表按 `(provider_id, workspace_id, install_kind, COALESCE(app_id, ''))` 键,带 `revoked_at IS NULL` — 同一工作区内同一 bot 的 internal 与 external 安装因为 `install_kind` 不同会落在不同行。

---

## 签名模式自动检测

飞书有两种签名模式 — 一种强制(`verification_token`),一种可选(`encrypt_key`,用于 AES-256-CBC 事件加密)。集成自动检测发布者配置的是哪种:

```ts
detectSigningMode(verificationToken, encryptKey):
  if encryptKey 存在且足够长(>= 16 字符)  → "encrypt_key"
  else                                       → "verification_token"
```

任一情况下,常量时间比较防御计时攻击。WS payload 信封通过根是否存在 `encrypt` 字段来区分模式。

---

## 会话粒度

| `session_granularity` | scope key | 使用场景 |
|---|---|---|
| `per_chat` | `chat:oc_<id>` | 群运维 — 每个群一个持续上下文 |
| `per_chat_user` | `chat:oc_<id>:user:ou_<id>` | 1:1 运维 — 群内每个用户独立会话,但上下文仍按群索引 |

数字人在新 scope 的首条消息上,通过 `claimPending(scope, placeholderSessionId)` 抢占占位会话(DB 行 `insert ... onConflictDoNothing`)。agent 线程起来后,`fulfillPending(scope, realSessionId)` 把占位换成真实 session_id,状态 `pending → active`。若同一 scope 又带着不同 sender 到来且旧会话仍 active,路由复用现有 active 会话 — `reassignIfInactive` 仅在状态 `pending` 且 `created_at < now - 60s` 或状态 `completed` 时触发。

---

## 表(D1 / SQLite;Postgres 镜像在 `node-pg` 下)

| 表 | 行数 | 热路径 |
|---|---|---|
| `feishu_apps` | 每租户每个 OMA bot 应用 1 行 | 入站事件上按 app-id 反查 |
| `feishu_installations` | 每个安装 1 行(工作区 × 应用 × 类型) | WS runner 生命周期,tenant_token 缓存 |
| `feishu_publications` | 每个 OMA agent × environment × 租户 × 安装 1 行 | 向导状态、能力集、persona |
| `feishu_thread_sessions` | 每个 publication × scope 1 行 | 会话分配,claimPending → fulfillPending |
| `feishu_setup_links` | 短期一次性 token | console → setup-page 交接(目前未用 — 向导内置) |
| `feishu_webhook_events` | 每个投递事件 1 行 | 按 delivery_id 去重 |

迁移:`apps/main/migrations-integrations/0008_feishu_publication_first.sql`。

---

## 密钥

- **存储**:`feishu_publications` 上的 `app_secret_cipher`、`verification_token_cipher`、`encrypt_key_cipher`;`feishu_installations` 上的 `tenant_access_token_cipher`。Cipher key 是 `WebCryptoAesGcm(platformSecret, "integrations.tokens")` — 与 Slack 同形。
- **不存储**:App ID 明文(不保密 — 飞书标识符在 bot 加入的每个群上都是公开的)。
- **解密** 由 integrations worker 门控;Agent 沙箱永远见不到明文 App Secret / Encrypt Key。`tenant_access_token` 在每次 WS 连接时解密(以及数字人 MCP 工具的每次 REST 调用)。

---

## Worker(apps/integrations)

| 文件 | 职责 |
|---|---|
| `apps/integrations/src/routes/feishu/publications.ts` | `/integrations/feishu/start-a1`、`/credentials`、`/publications/*` HTTP gateway |
| `apps/integrations/src/routes/feishu/setup-page.ts` | Setup-page HTML 表单(目前未用 — 向导内置,保留以备未来 handoff-link 路径) |
| `apps/integrations/src/wire.ts` | 把 publications + setup-page 接入 CF worker 路由 |
| `packages/feishu/src/provider.ts` | 出站 WS runner 生命周期:拨号、401 重拨、claimPending/fulfillPending |
| `packages/feishu/src/webhook/parse.ts` | 入站事件归一化:信封区分 `encrypt_key` 与 `verification_token` |
| `packages/feishu/src/webhook/signature.ts` | `detectSigningMode`、`constantTimeEqual`、HMAC-SHA256 challenges |
| `packages/feishu/src/oauth/credentials.ts` | App-Secret → tenant_access_token 铸造 + 2h 缓存 + single-flight |
| `packages/feishu/src/api/client.ts` | 出站 REST:`sendText`、`updateText`、`addReaction`、`removeReaction`、`getChatName` |
| `packages/feishu/src/scope.ts` | `scopeKeyFor(granularity, chatId, userId?)` |
| `packages/feishu/src/signal.ts` | `FEISHU_SIGNAL_PROTOCOL_PROMPT` — 给 agent 系统提示的非 Slack 信号措辞 |

---

## Console 页面(`/integrations/feishu/*`)

| 页面 | 职责 |
|---|---|
| `IntegrationsFeishuList` | 租户卡片(已上线工作区)、PendingRow(进行中的向导)、PublicationRow(每个 publication 摘要) |
| `IntegrationsFeishuWorkspace` | 单租户管理:publication 卡片含 persona + 能力集 + session-granularity 单选 + 能力多选 |
| `IntegrationsFeishuPublishWizard` | 三步:PickStep → CredentialsStep(4 密钥表单,带显隐切换 + Event URL 复制)→ CompleteStep(成功 banner + URL 验证清单) |

`IntegrationsFeishuClient` 放在 `apps/console/src/integrations/api/feishu-client.ts`,这样它的覆盖率门槛不受同模块的 Slack/GitHub/Linear 客户端拖累。

---

## 飞书侧限制

| 限制 | 应对 |
|---|---|
| `tenant_access_token` 2h 过期;无 refresh_token — 需 App ID + App Secret 重铸 | 缓存 + single-flight + 过期前 60s 刷新缓冲;遇 401 刷一次再重试 |
| 每个应用消息速率限制(~50 req/s) | API 客户端对 `im/v1/messages` 调用令牌桶;表情回应按每条用户消息批量 |
| Bot 只能编辑自己 24h 内发的消息 | `updateText` 返回飞书错误码;UI 显示"过久无法编辑",回退到追加一条 |
| 群重命名无 API;`chat_name` 仅在首条消息接收时可解析 | `getChatName` 每个 scope 调一次,缓存在 `feishu_thread_sessions.chat_name` |
| WebSocket 无明确原因码断开 | Runner 把任何关闭视为瞬态,指数退避重拨(1s → 30s);连续 4 次 `99991663` 翻状态 `needs_reauth` |
| `encrypt_key` 可选 — 部分发布者只配 `verification_token` | `detectSigningMode` 回退到 `verification_token`;对原始 payload 做 HMAC-SHA256 |
| `chat_id`(`oc_*`)与 `user_id`(`ou_*`)是租户范围的,非全局唯一 | 所有反查都用 `(publication_id, scope_key)` 作 dedup 元组 |

---

## 后续工作(本轮不做)

### ISV 应用商店路径

目前 `tenant_type = external` 在 schema 和向导里支持,但 WS runner 硬编码 `internal` 鉴权。要发布真 ISV 应用,需要每安装拨 WS(每租户一条 socket)而非每 bot 拨,每 `feishu_installations` 行独立存 `tenant_access_token` 并独立刷新。

### Thread 内回复

飞书用 `root_id` 支持 thread 回复。当前 parser 忽略它 — 每条消息唤醒同一 scope。threading 会让我们按 thread 区分(`chat:oc_x:root:om_y`)而不是按群。

### 卡片流式

`im/v1/messages` 支持通过 `card_id` 机制就地更新的 card-message 类型。当前用 `updateText` 流式,渲染干净但丢掉了结构化卡片特性。

### 每 bot 身份

PRD Phase 2:每个 persona 生成一个真飞书 bot,而不是一个 bot 带多 persona 头像。需要每 bot 凭证保险柜 + 消息发送时选 bot 的路由层。

---

## 测试覆盖

| 层 | 位置 | 用例 | 覆盖率 |
|---|---|---|---|
| 包内单元 | `packages/feishu/test/` | 68 | 99% 行、95% 分支 |
| CF 适配器 SQL | `packages/integrations-adapters-cf/test/feishu-adapters.test.ts` | 39 | 95% 行、81% 分支 |
| Console 客户端 | `apps/console/src/integrations/api/feishu-client.test.ts` | 17 | 100% 行、100% 分支 |
| 端到端(活飞书沙箱) | 手动冒烟;未来 Playwright 框架 | — | — |

合计:**144 个用例通过**。门槛:行 ≥ 80%,分支 ≥ 70%。

---

## 延伸阅读

- [`linear-integration-current.md`](../linear-integration-current.md) — 本文在 Linear 上的镜像
- Slack 镜像模式(publication-first install):见 `apps/integrations/src/routes/slack/publications.ts`(git 历史)
- [`feishu-multi-agent-integration-prd.md`](../feishu-multi-agent-integration-prd.md) — PRD Phase 1 + Phase 2 上下文
- [`feishu-session-lifecycle.md`](../feishu-session-lifecycle.md) — 会话策略(事件级 Session + Memory 沉淀)
- [`secrets-design.md`](../secrets-design.md) — Vault + 外部 secret manager 分层
- [`architecture-overview.md`](../architecture-overview.md) — 系统拓扑