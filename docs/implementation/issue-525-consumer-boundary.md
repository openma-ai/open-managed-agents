# DB consumer 边界、顺序与事务性

> 历史审查记录：以下诊断/探针以 `edde3af523b0e2896d018d11248f99c3d8bc5a3e` 为基线，不代表实现后的现状。用户已批准一起修复；当前交付边界见 [实现说明](./issue-525-implementation.md) 与 [provider 语义核对](./issue-525-provider-semantics.md)。

本文件补充[异常处理总规划](./issue-525-exception-handling-plan.md)。当前交付架构规划与隔离复现，不修改生产代码，不安装外部 MQ。建议借鉴 pg-boss 的消费机制，先从已有实现提取最小通用内核；不把复制一套完整 pg-boss 作为目标。

## 现状与依据

- `managed-agents-domain` 不依赖 consumer；`NodeSessionExecutionWorker` 已在 `control-plane-node`。需要进一步分离的是这个 worker 内的通用消费循环与 session 专属调度规则，而非把一个已位于 domain 的 consumer 移出去。
- `session-event-store-sql/src/index.ts` 的 `appendWithExecutionOutbox` 已将 revision guard、事件、execution row 和 session 更新放进同一个 `SqlClient.batch`。该 port 要求全成全败；Node 配置启用 `executionOutbox: true`。这已经是事务型 admission，拆层时必须保留。
- `SessionExecutionStorePort` 同时包含 claim/renew/settle 和 interrupt、steerQueued、hold 等业务规则，不能直接改名为通用 Queue。`NodeSessionExecutionWorker` 也直接处理这些规则。
- 仓库已有 `packages/queue`，含 SQL、CF 和内存 adapter，以及 claim token、heartbeat、DLQ。其公开 `Queue` 没有事务内入队、严格分组顺序、结果未知暂停等契约，不能直接宣称满足长 session 执行需求。优先复用可证明正确的机制，避免建立第三套领取/续租系统。
- ADR 0006 约定 execution store 为唯一执行权威，dispatch 仅为唤醒提示。该原则应保留。现有驱动的提交结果未知重试与旧输出身份问题仍需修复，已有事务和 fence 不等于全部恢复路径安全。

## 建议分层

| 部分 | 通用或业务内容 | 责任 |
|---|---|---|
| Domain / application | 业务 | session 事件、接收规则、interrupt/steering、何时完成或等待用户 |
| Session execution adapter | 业务 | 将事件映射为执行任务，提供顺序 key、重试/暂停决策；调用 harness 与资源生命周期服务；持久化业务结果 |
| Consumer runtime | 通用 | 有界并发、背压、claim/renew/settle 编排、attempt 取消与子任务归属、停止接单与 drain、健康与错误上报 |
| Store / delivery adapters | 基础设施 | SQL 原子状态转换；DB polling 或未来 broker 唤醒、确认、重投；持久对账 |

通用内核不得导入 Session、模型、工具或 sandbox 类型。它只理解不透明任务 ID、排序 key、attempt token、期限、取消信号和处理结果。sandbox 的创建、复用、隔离和销毁留在资源生命周期服务；通用 Scope 负责调用清理接口，不定义业务保留策略。

当前 session 工作由同一 execution row 授权和 fencing。通用内核通过 adapter 使用这份权威记录；不得再增加一个独立 job lease 来争夺同一次业务执行的所有权。未来 broker 的 delivery receipt 仅证明一次消息投递，不授予业务写入权。

处理结果至少区分完成、可安全重试、不可重试、取消、失去所有权，以及需要持久对账的未知结果。通用 consumer 执行策略，业务 adapter 判断副作用是否可重放。发生未分类异常时，不能默认自动重试可能已产生副作用的任务。持久 pause/hold 必须参与所有直接 claim 和 recovery 路径；局部 catch 或内存标记不够。

consumer 只能处理它收到的结果：工具边界须先保留确定性并撤销未知副作用后的调用能力，不能转成普通错误文本后任模型再次 dispatch。ACP 等原生 harness 无法拦截工具时，在 prompt 前持久登记并使用保守恢复；详细能力矩阵见总规划。通用 consumer 不承担识别模型语义或推断外部工具是否执行的责任。

## 顺序的具体保证

目标是对同一个 `(workspace, session, lane)` 按规范接收顺序处理；不同 key 可并行。共享 workspace 的 session 是否跨 lane 互斥由业务策略决定，不能混同于 FIFO。当前 `serializeSessionClaims` 仅在 `checkpoint_restore` 策略启用，不能宣称所有 session 全局串行。

需要区分三种顺序：

1. 接收顺序：以同一事务中确定的 session revision 与批内位置，或等价的每 key 单调序号为准。
2. 执行顺序：同 key 的后继不能越过未解决的前驱；重试、未知结果、永久失败如何阻塞或经显式业务动作解除，需要持久规则。
3. 结果发布顺序：提交还要校验原 attempt/generation，防止已失去 lease 的 handler 晚到发布。

当前 SQL 的候选选择和排队读取按 `admitted_at_ms, id` 排序。通常 admission 时间来自 session `updatedAt`；相同毫秒仍按 ID 比较，不能代替接收序号。[ordering probes](./issue-525-ordering-probes.mjs) 使用实际 coordinator 与原生 SQLite：先 admit `z_first`，再 admit 同毫秒 `a_second`，实际先 claim 后者；回退时间戳同样可使后入先出。两项现状断言通过，未覆盖 HTTP 完整链路或生产数据库并发。

实现严格顺序需要补持久序号及迁移规则，并让 claim、steering、held-row 合并和恢复统一使用。历史记录优先由已持久化事件位置回填；无法还原的记录保留明确兼容策略，不能凭时间戳声称恢复了原始接收顺序。

interrupt、requires_action continuation、steering 是当前业务允许的控制/合并路径；不能把所有事件排成无例外的队列，否则等待工具确认的任务可能永远堵住解除等待的事件。这些例外应由业务 adapter 明确定义并测试，通用 FIFO 内核不识别具体事件类型。

串行约束须在原子 claim 时成立，不能只依赖 SELECT 候选与进程内 Map。需要在支持的真实 DB 上验证多 worker 争抢、同时 admission、序号回填和租约过期。失去 lease 的外部操作若无法停止，数据库互斥也不等于现实副作用不重叠；结果未知时必须阻塞相关 key 或按业务确认的隔离策略处理。

## 事务性与未来 MQ

| 操作 | 可以承诺的边界 |
|---|---|
| 业务事件 + 待执行记录 | 同一数据库短事务，共用事务上下文/原子 batch，任一失败全部回滚 |
| SQL 业务结果 + 执行终态 | 能在同一事务提交时原子提交；否则需稳定身份、幂等读回和恢复协议，不宣称本来就是一个事务 |
| DB 提交 + 外部 MQ 发布/ack | 不存在自动跨系统原子性；用事务 outbox、重发、去重和对账闭合崩溃窗口 |
| SQL 状态 + 模型/工具/外部 API | 不承诺通用 exactly-once；依赖外部幂等键、可查询结果、补偿或持久暂停人工确认 |

事务接口不能只是“先调用业务 store，再调用 queue.enqueue”：必须让它们加入同一事务。可以保持 infrastructure 层的原子 batch，或通过应用层 unit of work port 组合；不让 domain 导入 SQL driver。跨进程迁移也保留这个接口语义。

长模型/工具调用在短事务之外运行，不持有贯穿整个 attempt 的 SQL 事务。启动意图、执行结果和状态转换分别短事务提交；commit 响应丢失先按稳定操作 ID 对账，不能盲目重跑。

第一步支持的 MQ 扩展方式是：DB 保留执行记录/顺序/fence 权威，事务提交唤醒 outbox；relay 发布稳定任务/key 提示；broker consumer 根据提示回到权威 store claim。重复、延迟、乱序提示不能改变执行顺序。遗漏提示由持久 outbox 重发和扫描兜底。

relay 需先获 broker 发布确认，再记发送完成；中间崩溃允许重复。broker handler 的 ack 只在提示已被可靠处理或恢复责任已持久交接后进行，绝不表示业务已完成；若未来改为 ack 随业务完成，则必须先持久提交业务结果，再 ack，重复投递读回终态。receipt、executionId 和 attemptId 分开。

relay 停机、broker 长时间不可用、DLQ、按 key 丢失提示、consumer 重启、分区再均衡都需有持久恢复路径。broker 原生分组顺序有助于减少冲突，但正确性最终仍由 store 的序号与 fence 校验。

这条路线能接真正 MQ，并降低高频全表轮询、扩展投递与 worker 数量；它仍依赖数据库的 claim/renew/settle 写入能力。不能宣称已消除 DB 瓶颈。若以后要把执行权威也迁到 broker，需重新设计业务事务、顺序、重放与 fencing，属于独立迁移，不是换 adapter 即完成。

## 从 pg-boss 借鉴什么

已核对官方文档（2026-11-05）：

- [事务 adapter](https://pgboss.io/api/adapters)：入队/完成可加入已有数据库事务。值得借鉴事务接缝，而非在两个普通 Promise 调用外包装“事务性”名称。
- [队列策略](https://pgboss.io/api/queues)：区分按 key 串行策略与普通队列；strict FIFO 对 active/retry/failed 的前驱阻塞，但未到可执行时间或未满足依赖有例外。不能把该策略直接当成本项目所有事件的语义。
- [worker](https://pgboss.io/api/workers)：背压、停止、heartbeat 和 attempt 身份；事务 worker 的事务贯穿 handler，官方建议适用短工作，长任务采用短完成事务。
- 同一官方队列说明明确网络分区或超时后旧 handler 仍可能运行，应用仍需幂等；attempt 身份防旧结果 settle，并不保证外部副作用只发生一次。

如果未来部署约束收敛到 PostgreSQL，可评估直接用 pg-boss adapter，减少自研维护。当前还支持 SQLite/MySQL/CF，不把仅限 PostgreSQL 的能力变成公共契约中的默认保证。跨 adapter 保证要逐项满足，缺少关键能力应在配置时拒绝或给出明确受限模式。

## 实施与验收

先定义上述合同及独立 conformance suite，再修已证实的 fence/stop/不安全重试问题；安全规则稳定后抽取 consumer。保留现有 execution store 为唯一权威，逐步拆出业务 adapter。外部 MQ 接入和 PostgreSQL-only 选型留到后续实际容量需要时进行。

验收需覆盖：相同毫秒接收、并发 admission、同 key 重试阻塞、不同 key 并行、continuation/steering 不死锁、两个进程 claim、旧 attempt 续租/settle/清理失败、业务写入与入队回滚、commit 成功响应丢失、DB 提交后发布前崩溃、broker 发布后 outbox 标记前崩溃、结果提交后 ack 前崩溃、重复/乱序/漏提示、DLQ 对账与非幂等副作用结果未知不重放。

独立通用 consumer 测试不得依赖 session/harness；业务 adapter 测试验证事件与资源规则；所有计划声称支持的数据库 adapter 跑相同契约测试。增加真实 MQ adapter 后，还需对应 broker 的集成验证；内存 fake 通过不等于已验证真实 MQ。
