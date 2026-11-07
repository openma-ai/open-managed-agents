# 异常处理总规划

> 历史审查记录：以下诊断/探针以 `edde3af523b0e2896d018d11248f99c3d8bc5a3e` 为基线，不代表实现后的现状。用户已批准一起修复；当前交付边界见 [实现说明](./issue-525-implementation.md) 与 [provider 语义核对](./issue-525-provider-semantics.md)。

## 目标与范围

本文件记录异常处理与执行生命周期规划。用户已同意按合同测试、结构抽取和策略修复分步落实；后续沙箱审查发现持久归属与旧清理的新缺口，现已进入合同、资源生命周期和执行边界的联合实现。Effect 是执行内核的实现选项，不单独发起全仓迁移。

目标是让每个异常都能回答五个问题：**发生在哪里、谁负责处理、操作是否已生效、能否安全重试、何时算处理完成。**

覆盖 Node 请求、模型/工具/MCP、数据库、执行调度、资源回收、正常停机及进程故障恢复。公开 API/事件语义保持兼容；CF 路径、SDK/CLI 全面迁移和外部队列不在本轮范围。

范围边界以行为而非文件路径判断：`sql-client/driverRetry`、SQL coordinator 等由 Node 与 CF 共用。优先在 Node adapter/组合入口注入策略；若必须修改共享默认行为，D1 写入/批处理重试、CF scoped recovery 和事件语义兼容测试是合入门禁。CF 架构改造仍不在范围内。

架构按普通 Node 服务、通用 consumer、session 业务执行器分层；consumer 位于 domain 之外。详见[DB consumer 边界、顺序与事务性](./issue-525-consumer-boundary.md)：借鉴 pg-boss，保留事务型 admission 与唯一执行权威，明确未来 MQ 可替换的投递边界和仍依赖 DB 的保证。现有时间戳 + ID 排序不能直接承诺严格接收顺序，需以持久序号和契约测试补齐。

新增硬前置：[Session sandbox 持久引用与独立生命周期](./issue-525-session-sandbox-ownership.md)。Session 持有 handle，attempt 只有使用权，sandbox 自身 lease/状态及 readiness 独立推进，内存只作缓存。已用实际 Sprites adapter + 假 provider 复现旧 terminate/orphan 删除新 owner 所用资源；先解决归属与清理合同，再进行 consumer 抽取和工具墙接入。对照 #390、ADR 0014 和 #446，避免另立相互冲突的沙箱设计。

## 统一分类与职责

| 类别 | 处理负责人 | 规则 |
|---|---|---|
| 输入、配置、鉴权、支付等不可重试失败 | 请求或 attempt | 给出可理解的失败结果，等待输入/配置修正；不退出进程 |
| 限流、可恢复依赖故障 | 发起 operation 的组件 | 仅在安全重复且预算允许时退避重试；尊重 Retry-After |
| 结果确定的普通工具失败 | harness | 作为工具结果交给模型处理；可能已产生未知副作用的错误不进入这个分支 |
| 用户取消、lease 丢失 | attempt | 停止后续工作、撤销旧输出能力；取消与故障分别记录 |
| 超时或断线，结果未知 | operation/tool 边界 + attempt + recovery | 在转成模型侧错误前保留确定性；阻止同 attempt 再 dispatch，持久暂停并读回/幂等对账，全部接管入口禁止盲目重放 |
| 清理失败 | 资源生命周期组件 | 保留主错误，持久记录待回收资源，有限重试并告警 |
| 已归属受管任务的程序缺陷 | supervisor | 失败该任务，记录完整 cause，评估共享状态是否仍可信 |
| 未归属的进程致命异常 | process + Docker/systemd | 最小可靠记录后退出，由外部监护拉起并走持久恢复 |

“业务不可重试”不用 process fatal 命名。错误源负责分类和保留 cause；operation owner 决定重试；attempt owner 决定执行结果；coordinator 负责持久状态；API 层只映射公开响应。避免每层各写一套正则和重试逻辑。

## 六条全局约束

1. **未知结果不能当失败未执行。** timeout、connection lost、取消信号均不证明外部操作已停止或已回滚。
2. **重试以操作安全性为依据。** 结合幂等键、CAS、明确回滚或读回协议；多个 SDK/IO/harness/attempt 层共享总 deadline/预算，避免各自重试造成次数相乘。
3. **所有异步工作都有归属。** 明确属于请求、attempt、session 资源还是服务；归属结束后停止/等待子任务，晚到结果也有人负责。Scope 关闭不是 provider 物理销毁成功的证明。
4. **执行身份不可借用。** 输出、取消、清理绑定原 attempt/fence 和资源实例；旧工作不能读 session map 后借用新 owner 的身份。
5. **错误处理不能制造假成功或覆盖主错误。** 保存主 cause、清理错误和观测错误；日志/metric 失败不能改写业务结果。best-effort 必须有明确的补偿或可接受丢弃理由。
6. **进程恢复与业务恢复分开。** 自动拉起只恢复服务；任务依照 SQL/规范事件恢复，副作用不确定时中断或对账，不能默认重跑。

## 工具结果未知与 harness 能力门禁

错误处理先判断外部操作是否可能已生效，再区分取消与结果确定的普通失败。取消信号不能把未知副作用变成“未执行”。工具包装器、确认后工具执行器、harness 桥接均须保留操作身份与结果确定性；`OutcomeUnknown` 不能仅降级为供模型阅读的错误文本。

未知副作用在当前 attempt 内立即阻止后续相关 dispatch，并持久登记暂停/待对账；不能只要求模型不要重试。无法可靠识别后续调用是否重复同一逻辑操作时，保守暂停该执行的副作用能力。所有恢复、continuation、人工重试和新消息接续都必须尊重该暂停；普通新输入不得自动解除。原 attempt 还未结束不代表不会发生重放。

| 执行路径 | 调用前屏障及验收要求 |
|---|---|
| 宿主可控工具入口（默认/Pi 等逐一确认） | 外部 dispatch 前提交稳定操作意图；普通调用及用户确认后执行共用确定性分类和能力撤销。逐个 harness 验证确实经过入口，未验证不视为覆盖 |
| ACP 原生工具 | 宿主当前只镜像通知，不能据此宣称工具调用前已记录。至少在发送原生 prompt 前持久标记可能执行副作用；崩溃后无已确认的安全恢复协议则不自动重发 prompt。更细粒度重放需原生协议提供可验证的 dispatch/结果合同 |
| 自定义或其他原生 harness | 声明能否拦截副作用、支持稳定操作 ID/幂等或对账；能力未知按保守路径处理，不凭缺少 tool_use 事件推断尚未执行 |

源码依据：`apps/agent/src/harness/tools.ts` 的 `safe` 和 `node-managed-confirmed-tool-executor.ts` 当前会把异常转成普通工具失败；`node-managed.ts` 的 ACP 分支不提供宿主工具集，`acp-translate.ts` 会缓存原生 tool_call 通知。前者可能导致同 attempt 模型重试，后者使规范事件无法单独证明工具尚未开始。新增 watchdog 或加速接管前必须覆盖所有启用的 harness；不具备安全重放能力的路径保持持久暂停策略。

## 生命周期设计

| 生命周期 | 拥有的内容 | 结束条件 |
|---|---|---|
| service | HTTP admission、poller、活动 attempts、公共连接池 | 先停止接单，再有界等待/取消，交接回收责任，最后关闭依赖 |
| attempt | controller、heartbeat、阶段 watchdog、工具连接、输出绑定 | 结束或失去 fence 时立即撤销能力；全部子任务/晚到结果可追踪 |
| session 资源 | warm sandbox、workspace、checkpoint | 独立复用/保留策略；不能仅因无 running row 被判孤儿 |
| durable recovery | 执行记录、结果未知、allocation intent、资源登记与 orphan disposal | 跨进程持续有效；通过 fenced 更新、幂等读回和真实资源确认收敛 |

watchdog 使用阶段和操作状态判断，不以“没有模型输出”统一判定卡死。正常停机支持 drain；全局未知 fatal 不依赖复杂异步清理。真实资源删除失败需要持久回收责任和告警，不能只删 Map。

## 分期安排

### 一：统一规则与测试基线

- 形成单一内部错误分类、operation policy 和公开错误映射；保留业务层已有正确的工具结果与 4xx 语义。
- 明确日志字段：workspace/session/execution/attempt/owner/generation、operation/phase、cause、结果确定性、最终处理动作。
- 明确每个重试层的预算和不可重试条件；对 ConnectionLost/Timeout 建立结果未知规则。
- 定义通用消费与业务执行的边界、每 key 顺序及事务合同；不会因抽取 consumer 而拆散事件与 execution 的原子 admission。
- 将已发现问题转成期望正确行为的回归测试。当前审查探针断言的是现有缺口，不能直接当作修复验收。

### 二：修复已证实的生命周期与策略缺口

- 修复晚到输出的 fence 绑定、stop 后接单、并行初始化的晚到工具回收。
- 修复 gate/cancel 身份校验、pending cancellation 收敛、失败 disposal 可重试与持久交接。
- 统一 auth/payment/config 的不可重试策略；按 operation 消除提交结果未知时的不安全重试。
- 区分 process exception 与可归属的 operation failure，保留未知 fatal 的外部重启路径。

### 三：在稳定合同下整理执行内核

- 优先以 Node worker → runtime → runner 的一次完整 attempt 作为 Effect 使用单元。
- 在合同与正确性修复稳定后，提取不依赖业务类型的 consumer 内核；session interrupt/steering、恢复策略和资源管理留在业务 adapter/服务，不建立第二份执行所有权。
- 用 service/attempt Scope、受归属的 fibers、typed failure/Cause、有限 retry 表达已确定的规则；本阶段仅保持已有超时行为，不启用新的 watchdog、不缩短期限或扩大中断范围。
- SDK、HTTP 和数据库公开 Ports 保留 Promise；在边界传递取消并处理不支持中断的操作。
- 复用仓库现有 Effect `3.22.1`，主版本升级独立安排。正确性修复与框架重构分开提交，便于审查。

### 四：完善持久恢复，再启用新的阶段 watchdog

- 首先完成 dispatch 前持久屏障、结果未知处理以及 sweep/直接 claim 等全部接管入口的副作用保护。它们是新增 watchdog、缩短期限、扩大中断范围或加速 lease release/redelivery 的启用前置条件；即使不主动 release，停止续租后的自然过期也可能触发接管。
- 屏障按上述 harness 能力矩阵落地，并覆盖当前 attempt 内模型再次调用及确认后工具路径；没有原生工具入口控制能力时，以 prompt 前持久意图和保守不重放实现，不等待 tool_use 通知才登记。
- 在远程创建前保存 allocation intent，关联 owner/generation/稳定创建请求 ID；按 provider 能力使用幂等创建或资源标记查找，创建返回后登记 runtimeId。恢复器需扫描未完成 intent 与已登记资源，覆盖“provider 已创建、调用方尚未获得或持久化 handle”的窗口。
- 已知资源的回收责任须能从持久登记恢复，不能只依赖 terminate 失败后临时 enqueue。覆盖销毁失败后、enqueue 前崩溃和 DB 不可用；接通 orphan reconciler，并验证旧 generation 清理不会误伤接管者。
- provider 若不支持幂等创建/查找，需验证其创建时 TTL 等替代兜底及到期条件；查找与可靠 TTL 都不可用时，明确不保证自动回收，提供人工对账路径，不能宣称仅靠 Scope/reconciler 已实现最终释放。
- 上述恢复门禁通过后，再启用新的阶段 watchdog，分别验证合法长操作与真实 stuck；同时覆盖真实进程退出/重启、数据库提交响应丢失、provider 创建/销毁失败。

## 验收与可观测性

每类错误至少验证：公开结果正确、规范事件/SQL 状态正确、工具副作用次数正确、资源最终释放或进入持久待回收、旧 fence 不能影响新 owner、日志保留完整诊断证据。

重点场景：

- startup/model/tools/harness/drain/publish/settle 各阶段故障；主错误与清理错误同时发生。
- 原操作已生效但响应丢失；timeout 后晚到提交；工具调用后结果未持久化。
- 确定性假模型在工具已生效但响应丢失后再次请求操作：普通工具与确认后执行都阻止再次副作用 dispatch，或用可验证幂等协议收敛；仅返回“不要重试”文字不算通过。
- ACP 原生工具已生效、规范工具通知尚未持久化时杀进程；重启后 prompt 前记录阻止自动重发。默认/Pi/自定义 harness 分别验证入口覆盖，能力不明时测试保守暂停。
- provider 创建成功但响应丢失、创建后立即 SIGKILL；销毁失败后 enqueue 前崩溃或 DB 不可用。重启后能查回资源或证明 TTL 兜底生效，不能只断言已有 orphan 队列清空。
- A 失去 lease、B 接管后 A 继续输出或清理；模型失败后工具晚到成功。
- stop 后 claim 数不增加；停机不无限等待；fatal 后单机监护拉起，业务不盲目重放。
- 长工具/模型首 token 静默继续合法运行，真正卡住的阶段有界退出。
- 涉及共享 SQL/重试策略时，Node 与 CF 的既有契约测试均通过；开启新 watchdog 前证明所有接管入口都不会重放不确定副作用。

运维指标按处理动作统计：安全重试、结果未知、lease 丢失、待回收数量及最长年龄、停机超时、process fatal/restart。频繁 fatal 或积压回收必须可告警；不能以“进程还活着”作为唯一健康标准。

## 审查依据与当前状态

[异常体系详细评估](./issue-525-exception-system-review.md)记录源码证据、已有保护、风险与 Effect 的适用边界。新增三组隔离探针共 **11/11** 满足现状断言：Effect/process 5 项、IO 3 项、runtime 3 项；另有前轮 7 项独立探针。它们不是全服务/provider 集成认证。

本轮只交付规划、评估和复现材料，未修改生产代码、未创建实现 PR、未部署。后续实现按上述分期进行，不以全仓 Effect 迁移为完成标准。

独立 subagent review 已提出并纳入三项修订：安全恢复作为新 watchdog 的硬前置条件（P1）、资源创建/登记之间崩溃窗口的恢复合同（P2）、共享代码的 CF 兼容门禁（P2）。reviewer 独立重跑新增三组探针，11/11 现状断言通过；真实数据库网络故障、provider 生命周期与多 owner 并发仍待实现期集成验证。

随后按用户要求由不继承对话历史的 reviewer 重新审查，额外提出两项 P1 规划缺口：同 attempt 内模型重试未知副作用，以及 ACP 原生工具不经过宿主 dispatch 屏障。两项已补入上文策略、harness 能力矩阵与验收场景。该 reviewer 独立重跑异常探针 11/11、顺序探针 2/2；这些均为现状复现，生产修复尚未实施。

修订后同一空上下文 reviewer 已复核上述两项在规划层面闭合；该次复核未重跑测试，不代表生产实现已通过验收。
