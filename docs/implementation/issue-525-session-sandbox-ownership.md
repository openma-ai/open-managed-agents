# Session sandbox 引用、独立生命周期与工具墙

> 历史审查记录：以下诊断/探针以 `edde3af523b0e2896d018d11248f99c3d8bc5a3e` 为基线，不代表实现后的现状。用户已批准一起修复；当前交付边界见 [实现说明](./issue-525-implementation.md) 与 [provider 语义核对](./issue-525-provider-semantics.md)。

用户进一步明确：sandbox handle 按值寻址，由 Session 持久持有；正确性不依赖 worker 内存；attempt 的 lease/状态与 sandbox 的 lease/状态解耦。本补充将此要求并入[异常处理总规划](./issue-525-exception-handling-plan.md)，记录新发现的缺口及实现前置条件。通用 consumer 抽取暂缓，生产代码尚未改动。

## 已有议题与约束

- [#390](https://github.com/openma-ai/open-managed-agents/issues/390) 跟踪 Session 创建时起盒、工具墙和沙箱生命周期。其[评论](https://github.com/openma-ai/open-managed-agents/issues/390#issuecomment-6577782312) 已明确指出 Node runner 的内存 sandbox 与任意副本 execution lease 之间的矛盾。
- [ADR 0014](../adr/0014-session-sandbox-provisioning-and-tool-wall.md) 状态仍为 Proposed，Open questions 1–3 尚涉及按 handle 重绑、provisioning fence 与未使用 TTL；不能把文档存在当作持久接管已实现。
- [#446](https://github.com/openma-ai/open-managed-agents/issues/446) 仅覆盖该 ADR rollout 第一步：新 port、兼容包装和 CF 原生实现；明确暂不移动 create-time provisioning。此次工作不顺带改 CF 路径或扩展该 issue 范围。
- [ADR 0005](../adr/0005-self-hosted-worker-runtime-resources.md) 要求恰好一个执行调度权威：外置 harness 是 SessionExecution，盒内 self-hosted harness 是 EnvironmentWork；RuntimeResourceFence 只负责资源发布，supervisor heartbeat 只是健康信号。

## 三种独立状态

| 对象 | 权威记录与职责 | 不应推导的结论 |
|---|---|---|
| Session sandbox binding | Session 关联的持久记录：真实 provider handle、资源 incarnation、配置指纹、期望状态、已观测 readiness、revision；允许 JSON round-trip 后重绑 | 仅持有引用不授予执行权；内存缓存不存在不证明远端资源不存在 |
| Sandbox 生命周期 | provision/prepare/ready/suspend/lost/retire/delete 与 provider 保活/留存策略；管理操作由持久 CAS 或生命周期任务租约串行化 | ready 或 provider TTL 仍有效不授予 harness 执行权；没有 running attempt 不代表孤儿 |
| Execution attempt | 唯一执行 lease、owner/attempt/generation；决定本次 harness/工具/结果发布的权限 | attempt 完成、取消或 lease_lost 不直接等同于 sandbox 删除 |

这里的“sandbox worker 独立 lease”若指起停/保活/回收的管理 worker，可以仅对相应资源管理操作授予权力；不得同时独立调度同一 harness 或续回已经失效的 execution 权限。盒内 EnvironmentWorker 本身就是该 placement 的执行 owner，不能再增加一个 SessionExecution claim。

Session 是资源引用的持有者；attempt 是受限使用者；worker SDK 对象/连接是可丢弃缓存。provider handle 解析还需要正确的租户、provider 配置/endpoint 以及本机资源的位置；这些通过受控持久绑定解析，不能把凭据塞进 handle。Docker/本机子进程按值寻址仍受所在机器可达性约束，不自动具有跨机器迁移能力。

## 工具墙是 readiness 与权限的两个条件

对外置 harness：Session 的沙箱 provisioning/保活由独立持久生命周期推进；attempt 获得执行 lease 后可进行模型请求。仅 sandbox-backed 工具等待 Session binding 的 prepared 状态，随后仍须校验本次 attempt 的有效使用权和资源 incarnation。工具列表、mount 路径等首轮能力描述从配置推导。

取消 attempt 撤销它的等待和使用权，不无条件取消 Session 正在进行的 provisioning；资源层按自己的留存/无人使用策略收敛。sandbox lost 使相关工具和资源操作不可用，不等于整个 attempt 必须被无条件重投。工具调用结果未知仍遵守总规划的持久暂停与防重放规则。

readiness 与权限分别校验，不能把“ready 就可运行”或“有 execution lease 就重新建盒”作为默认规则。等待要有期限和取消，配置/权限错误不能通过反复起盒掩盖。盒内 harness 无法在其计算资源尚未存在时先运行模型，不机械套用外置工具墙时序。

## 当前实现的具体缺口

1. **Node runner 无持久 live-binding 接入。** `node-managed-session-runner.ts` 的 `connectedSandbox` 只读 Map，`acquireSandbox` 经 create-only `buildSandbox`；workspace 协议使用的 `{provider: "node", runtimeId: runtimeGeneration}` 是本地 allocation identity，不是 provider 真实 handle。当前能恢复 canonical checkpoint，不等于能恢复任意 live sandbox。
2. **通用 provider composition 的缓存 miss 被映射为资源不可用。** `managed-runtime-sandbox/src/provider-runtime.ts` 的 `requireRuntime` 只读 Map，heartbeat 捕获错误返回 lost，inspect 返回 unknown。已有 provider.resume 与 checkpoint 恢复路径，所以缺口不在 provider 完全无法重连。
3. **跨 owner 复用同一资源时旧清理未受到完整约束。** 通用 terminate 接收 fence 却未检查；orphan reconciler 把记录直接送到 reap。Sprites managed context 未传 allocationId，create 按 Session 稳定名称取已有资源；terminate 与 reap 按名称删除，ownership labels 只验证 environment/session，不验证 attempt 或资源 incarnation。

[sandbox probes](./issue-525-sandbox-probes.mjs) 已执行 3/3，并由空上下文 reviewer 独立重跑：

| 探针 | 实际观察 |
|---|---|
| 新 composition 收到 JSON 序列化 handle | 假 provider 中资源仍存在；inspect=unknown、heartbeat=lost |
| A/B 两套真实 Sprites composition 获取同一 Session 资源，A 旧 fence terminate | 真实 adapter 调用删除 API；B 的资源状态变为 stopped |
| A 的序列化 orphan 交给新 reconciler，B 已使用同一资源 | 真实 reap 删除 B 正使用的资源，orphan 被标记 resolved |

探针加载实际 provider-runtime、Effect kernel、Sprites adapter 和 orphan reconciler 源码，仅 provider API 使用内存假实现；不访问真实资源或凭据。它们在一个 OS 进程内创建独立 composition，使用构造的过期 fence/替代 owner，不运行真实 claim 调度、SQL orphan persistence 或生产 Sprites 服务。证明的是危险入口与删除副作用可达，不是线上事故发生率或完整重启 E2E。独立 allocation 的现有保护仍然有效，不将本发现泛化到所有 provider/placement。

## 修复顺序与硬条件

1. 先锁定 Session binding、资源生命周期和 execution 使用权三份合同，补上述期望安全行为测试。readiness/provisioning 的执行记录不能只有本地 Promise。
2. 接入 `SessionSandboxBindingPort` 及 SQL adapter：持久 allocation intent，真实 handle 登记，配置/准备阶段，按 revision 原子迁移；缓存 miss 查询记录并重绑。创建响应丢失走查询/幂等/可靠 TTL 的已声明能力。
3. 将“释放本地连接/使用权”与“销毁物理资源”分开。资源管理者只有取得对应 incarnation 的持久 retire 权后才能删除；retiring 期间禁止新 owner 把同一 incarnation 重新激活。
4. 同一 physical runtime 的跨 owner 复用还要求实际副作用入口的 fencing、旧操作排空或可靠隔离。单次 `isCurrent` 后再 HTTP delete 存在检查与执行间竞态，不是充分修复。provider 无法保证时，保持独立 allocation + canonical restore，或在确认旧操作隔离前阻止接管；不能以普通重连冒充安全交接。
5. 生命周期独立后接工具墙，再提取通用 consumer。保持现有 checkpoint 恢复、资源 staging、Vault 刷新、outputs/memory 同步及终态去重；并覆盖同资源 handoff、旧 destroy 晚到、旧 orphan 晚到、进程缓存全丢和新的 Session 输入。

要验证的是丢掉全部 worker 缓存后，持久记录仍足以判断资源在哪里、准备到了哪一步、谁可使用、谁可回收。可重建的 SDK client、stream、AbortController 可以驻内存；它们不能成为以上事实的唯一来源。
