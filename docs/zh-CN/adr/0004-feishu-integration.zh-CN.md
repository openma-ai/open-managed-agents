# ADR 0004:飞书集成 — 镜像 Slack 的 Publication-First 安装

**状态**: 已接受(2026-08-13)
**决策者**: 工程
**取代**: 无
**相关**: [`linear-integration-current.md`](../linear-integration-current.md)、[`feishu-multi-agent-integration-prd.md`](../feishu-multi-agent-integration-prd.md)、[`feishu-session-lifecycle.md`](../feishu-session-lifecycle.md)

---

## 背景

我们需要为 OMA 上线飞书集成。现有 Linear 和 Slack 集成设定了模式:Linear 是 OAuth 优先(`installPersonalToken` + handoff-link 路径),Slack 是 publication-first(向导创建持久 `feishu_publications` 等价行,然后填密钥)。两者最终都收敛到相同的 `installations × publications × scope` 数据形态,但安装期 UX 本质不同,因为每个 Provider 的开放平台暴露的接入面不同。

飞书开放平台介于两者之间:
- 无公网 OAuth 流。应用在飞书管理后台配置,密钥服务端粘贴。
- 不需要公网回调 URL。入站事件通过每应用一条出站 WebSocket 推送。
- 用 4 个密钥(App ID、App Secret、Verification Token、Encrypt Key)而非 3 个。
- 同 schema 同时支持内部租户应用与外部 ISV 应用。

安装流程设计有三个候选:

### 选项 A — 镜像 Slack(publication-first 向导)

三步向导:PickStep → CredentialsStep → CompleteStep。第 1 步创建 `feishu_publications` 行(状态 `pending_setup`),第 2 步填密钥,状态转 `credentials_filled`,然后 `awaiting_install`,然后 `live`。无公网回调,无 handoff link。

**优点**:与 Slack 同形 — gateway worker 可复用 publication-first 分派器。一个浏览器 tab。UX 与 Slack 安装平齐。无 NAT,无公网入口,无 DNS。

**缺点**:未来 ISV 安装路径需要不同形态(对外时每安装要单独的 setup-link)。向导在用户输入(粘贴密钥)上阻塞 — 无"点链接安装"路径。

### 选项 B — 镜像 Linear(handoff-link + dedicated callback)

用户在 console 选 persona → 服务端返回 setup link → 用户打开 → setup page 让他们粘贴密钥 → 回调到专用 `/integrations/feishu/dedicated-callback` 落进 worker → worker 转 `pending_setup → credentials_filled → live`。

**优点**:setup link 可 DM 或在工作区保存。未来 ISV 路径顺畅(每租户开同一链接)。原生支持"交接给不同 persona"的 UX(管理员配置,用户安装)。

**缺点**:两次浏览器跳转。需要公网回调 URL — Cloudflare Workers 可以前置,但意味着飞书集成要暴露 HTTP 端点到公网,而 WebSocket 优先的设计明确避免了这一点。Schema 相同,但 gateway 要学新 `dedicated-callback` 路由。

### 选项 C — 单步("在此粘贴密钥"表单)

用户直接打开 `/integrations/feishu/install`,内联选 persona,粘贴 4 个密钥,提交。无 setup link,无向导,无回调。

**优点**:面最小。无状态机可调试。

**缺点**:无刷新续接。用户中途关 tab = publication shell 孤儿。在填完密钥前不能选 tenant-type / 粒度,意味着 schema 不能把那些选择提前落到持久 shell 上。

---

## 决策

**选项 A — 镜像 Slack 的 publication-first 安装**。按优先级排序的理由:

1. **飞书开放平台本质是"服务端粘贴密钥",不是 OAuth 重定向。** Linear 的 `installPersonalToken` 能用,因为 Linear 支持 personal API token + 工作区范围 OAuth。飞书不支持。最接近的是"创建飞书应用,复制 4 个密钥到我们 UI",这更接近"表单粘贴"而非"重定向舞步"。

2. **WebSocket 优先设计消除了公网回调的需要。** Slack 需要回调 URL,因为 Slack 的事件订阅模型要 HTTPS 入站。飞书的 `im/v1/messages` 事件流由 integrations worker 出站拨号。我们没理由暴露不需要的 HTTP 端点。

3. **与 Slack 的 schema 对称降低工程成本。** 5 张表(`feishu_installations`、`feishu_publications`、`feishu_thread_sessions`、`feishu_setup_links`、`feishu_webhook_events`)与 Slack 1:1。`packages/integrations-adapters-cf/src/d1/feishu/` 下的 repos 几乎逐行镜像 Slack,只在飞书 API 形态分叉的地方不同(4 密钥而非 3;`chat_id` 替 `channel_id`)。

4. **向导 UX 与 Slack 一致,运维已熟悉。** 同一三步节奏。Console 里同样的 `pending_setup → credentials_filled → live` 状态徽标。

---

## 后果

### 正面

- **Gateway 团队单一心智模型。** "Publication-first 安装"是已知形态,本 PR 没引入新安装拓扑。
- **无公网回调 URL。** 入站仅拨号。出站防火墙规则保持收敛。
- **未来 schema 改动是加法。** `feishu_installations` 上的 `tenant_type = external` 列预留但今天在 gateway 层未用 — ISV 支持落地时,我们增加每安装 WS runner 而不动 schema。

### 负面

- **无 setup-link 路径。** Linear 的 `createHandoffLink` 让工作区管理员代用户配置密钥。飞书向导阻塞到 *启动它的用户* 粘贴密钥。对多数团队这没问题(装 bot 的人和配它的人是同一人),但"IT 托管安装"工作流以后要单独的 handoff 路径。
- **`tenant_type = external` 是占位。** 向导记录它,schema 接受它,但 WS runner 硬编码 internal-auth 流。上 ISV 是后续工作。
- **`encrypt_key` 在飞书开放平台里可选,但向导总是展示它。** 我们支持 `verification_token` 单密钥路径(parser 检测缺失 `encrypt` 信封回退到 HMAC),但向导收两个。以 5 秒额外表单时间换"凭证状态永不模糊"。

---

## 考虑过但否决的方案

- **复用 Linear 的 `LinearPublicationShell` 类型作向导第 1 步响应。** 形态分叉够大(飞书无 OAuth 回调、无 handoff-link),共享类型只会需要 `omit`-重的映射。分开 `FeishuPublicationShell` 更干净。
- **单 bot-app 凭证给所有安装(一个 OMA bot,多租户)。** 这只是内部租户模式。外部 ISV 安装意味着 bot-app 是 OMA 拥有的,但安装是每租户的 — 不同 `tenant_access_token`,不同 WS,不同 `feishu_installations` 行。Schema 从第 1 天就支持;runner 还不支持。

---

## 悬而未决的问题

1. **卡片流式 vs `updateText`**:飞书支持通过 `card_id` 就地更新卡片。数字人今天用 `updateText`,能跑但不是飞书原生能力。等数字人主输出变成结构化(卡片、表格、动作按钮)时再评估。
2. **每 thread 范围(`root_id`)**:飞书用 `root_id` 线程化。当前 scope key 是 `chat:<chat_id>[:user:<user_id>]`。threading 会加 `:root:<message_id>` 给罕见的"数字人回复被 thread 化"场景。
3. **ISV 路径的 setup-link**:ISV 落地时,链接落在 `feishu_setup_links`(已存在但未用)还是新 `feishu_external_install_links` 表?

---

## 参考

- 飞书开放平台文档(内部参考,不可外部引用)
- 镜像的 Slack 模式:`apps/integrations/src/routes/slack/publications.ts`(见 Feishu 之前的 git 历史)
- WebCryptoAesGcm cipher key:`secrets-design.md`
- 会话范围 vs 群范围权衡:`feishu-session-lifecycle.md`