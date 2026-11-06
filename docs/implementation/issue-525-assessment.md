# Issue #525：实施前评估

> 历史审查记录：以下诊断/探针以 `edde3af523b0e2896d018d11248f99c3d8bc5a3e` 为基线，不代表实现后的现状。用户已批准一起修复；当前交付边界见 [实现说明](./issue-525-implementation.md) 与 [provider 语义核对](./issue-525-provider-semantics.md)。

结论：**原方案不能原样实施。** attempt 生命周期清理值得做，但不能由此推出“所有进程级异常都可捕获后继续运行”；按输出静默停止续租、无 running 行就删除 sandbox，以及先加速重投后补副作用保护，也需要改变。依用户“原 issue 方案不妥先告诉我”的要求，本次交付评估与隔离复现，不改生产运行时代码，不开实现 PR、不部署。

## 审查基线

- Issue：[525](https://github.com/openma-ai/open-managed-agents/issues/525)，读取时没有评论。
- 关联 PR：[524](https://github.com/openma-ai/open-managed-agents/pull/524)，仍为 open，已读取 diff 和 review。其取消转发与网络异常分类不等于允许所有 fatal 后继续运行。review 中“106 个 disconnect case 未复现 crash”是已有评审报告，不是本次复现结果。
- 分支：`cindy/bold-noether`；HEAD：`edde3af523b0e2896d018d11248f99c3d8bc5a3e`。
- GitHub 当前 main：`45a9c253b6192060206d8fa10a452c261317d6ae`。connector compare 确认只领先一个 #535 提交，改动为 database URL 解码及 artifact 测试，本文引用的 runtime/coordinator 源码未变。也读取了 main 的 AGENTS.md。

## 需要改变的主张

### 1. Scope 不是进程故障隔离边界

原主张：P0/P1 后，global `unhandledRejection` / `uncaughtException` 只需失败自己的 attempt，记录后继续；累计超过阈值才退出。

证据：`packages/control-plane-node/src/lib/db-unhandled-rejection.ts:26-56` 只有错误分类、日志、计数和退出，没有 attempt 归属、取消或等待清理。`packages/sql-client/src/db-errors.ts:315-339` 至多对 tagged DB error 保留 session/sandbox，没有完整 execution/attempt/generation。不能可靠指定“自己的 attempt”，也不能认定共享 DB client、全局缓存等没有受损。

实际 Effect 3.22.1 子进程复现：`Effect.scoped` + `acquireRelease` 包住一个等待中的 Promise；其 detached callback 抛错，由 `uncaughtException` 吞下。观察到 `caught=1, released=0`；只有显式 interrupt fiber 后才变为 `released=1`。因此清理取决于 scope 确实关闭，global handler 不会自动使等待中的工作退出。未响应取消的外部操作也可能在 scope 关闭后继续执行。

[Node 官方文档](https://nodejs.org/api/process.html#warning-using-uncaughtexception-correctly)明确不支持 uncaught exception 后恢复正常运行；推荐退出并由外部进程监护恢复。[Effect Scope 文档](https://effect.website/docs/v3/resource-management/scope)规定在 scope 关闭时释放，`scoped` 在内部 effect 结束时关闭 scope。已同时查看安装的 Effect 源码 `src/Scope.ts`、`src/internal/fiberRuntime.ts`。

建议：删除“最终切换全局 no-exit”的验收项。将可归属、已知可恢复的错误在所属 operation/fiber 内处理；未知 fatal 保留退出恢复。若长期目标是某个任意故障只影响一次执行，需要另立进程隔离设计；断路器不能证明第一次 fatal 后仍安全。现有 `isLeaseSafeFailure` 例外也不构成推广到所有异常的依据。

### 2. 输出静默不等于失活，先保障不重复再加速恢复

原主张：最近 N 秒没有 model chunk、tool result 或 event write 就停止续租并重投；副作用判断安排在 P2。

`node-session-execution-worker.ts:330-357,411-451` 的 heartbeat 确实不检查 progress。`coordination-policy.ts:284-299` 确实把续租期限 clamp 到绝对 deadline；deadline 到达时的决策是 finalize-interrupted。这个 unverified 细节已通过实际函数验证。

但工具执行可能合法静默，仓库 bash 明确允许默认 120 秒、最大 600 秒（`apps/agent/src/harness/tools.ts:510`）；模型等待首 token、启动/恢复、drain/publish 也可能没有列出的输出。单一 silence 阈值无法区分这些情况与 stuck。停止 heartbeat 也不等于已取消外部副作用，SQL fence 不能撤回已经发出去的请求。

建议：所有更快重投措施之前先建立 Node 的恢复证据与取消边界。heartbeat 表达 ownership/liveness；watchdog 表达具体阶段的期限、operation 状态和取消协议，二者分开。超时先取消/撤销旧执行能力，未能确认完成的非幂等操作标为 outcome unknown，不能自动再次调用。恢复证据不可读时不得当成“没有副作用”。

### 3. 复用资源与 attempt 状态必须分层

原主张：所有 runner/runtime map 都加 attemptId，scope 关闭全清；reconciler 按没有 running row 回收 provider sandbox；lease_lost 后只剩一个 sandbox。

`node-managed-session-runner.ts:289-380` 有明确的 warm sandbox 复用、配置指纹、存活 probe、workspace trusted 判断和后台预热。无 running row 是正常的 idle session 状态，不是孤儿证明。`workspaces` 和 sandbox 生命周期也包含跨 turn 保留的文件与 checkpoint。

`cancel`（同文件 `:282-285`）只按 workspace/session 找当前 controller 并 abort。实际方法级复现确认，取消后 sandbox binding 仍存在，而且接口不能区分旧 attempt 和当前 controller。`modules/node-managed.ts:818-825` 只向 runtime driver 传 attemptId，调用 runner 时丢失该身份。

建议：attempt Scope 仅拥有该 attempt 的注册、controller、订阅和活动绑定；session 资源保留独立生命周期。cleanup 必须捕获创建时的对象身份与 generation，先同步撤销旧绑定，再异步清理所捕获资源；不能在 await 后通过 session key 再找到可能已替换的资源。物理 reaping 需要可持久恢复的 disposal 记录、资源身份与原子所有权协议，必须防止检查后接管的竞态。

“任何时刻只存在一个物理 sandbox”在分区、异步 delete 失败下无法由 unbind 保证。更可验证的契约是：只有当前 fence 可提交规范输出；旧资源不能再获得新执行能力；销毁失败可追踪并最终重试。若要求物理单例，就必须在旧资源删除/隔离被确认前阻止接管，接受可用性代价。

## Issue 中未验证项的核实结果

| 原推测 | 本次结果与边界 |
|---|---|
| gate 注册后、try 前 throw 会泄漏 | 当前注册 `runner:970` 位于 accept 已进入的 try 中；不是这里存在一个未保护的注册窗口。最终 cleanup 之前仍有可抛错的 drain/broadcast 等路径，应另做阶段注入。 |
| stale attempt 清除新 gate | 确认 API 缺少 identity guard。实际调用 A register → B register → A clear 后 B 丢失；这是方法级复现，尚未复现生产并发调度。 |
| 所有 runtime maps 都不清 | 不准确。`startAborts` / `executionFences` / `outputChains` 已有身份校验清理；`starts` 成功后保留，stop 删除。不能统一按泄漏处理。 |
| pendingCancels 无 accept 会残留 | 确认：每 session 上限 16，但跨 session 无 TTL/回收。对 100 个不再 accept 的 session 调 cancel，保留 100 个 session；同一个 session 保持 16 条。worker 在 context lookup 期间取消后可直接跳过 runtime.run，符合“不会 accept”的路径。 |
| 物理 delete 失败会一直 gated | 确认。`runner:588-609` 保存 rejected Promise，后续 disposal 复用它而不重新调用 destroy。注入“第一次失败、第二次可成功”，连续调用两次仍只有 1 次 destroy，gate 保留。 |
| lease_lost 没有 discard | 确认 cancel 和该 turn 的异常/finally 路径没有主动 discard；方法级测试确认绑定仍在。所有 provider 上是否同时存在两个物理 sandbox 尚未实测，不能由本地 Map 推定。`replaceLostSandbox` 是本地检测 provider sandbox 消失的路径，并非跨 owner 接管的证明。 |
| Node 所有 redelivery 都重放 | 过于笼统。`runtime:169-180,244-250` 和 `runner:669-671` 已识别该 execution 最后一个规范事件为 idle 的已提交终态，并走 finishCommittedExecution。没有 terminal 的 tool-use 不受这个 guard 保护。 |
| Node 没有恢复证据检查 | claim/sweep 默认只按 lease 处理，production wiring 未配置 CF 式 recoveryScope/decider；SQL 也允许直接接管 expired running。因此只加一个周期 sweep decider 不够，必须覆盖所有 claim 入口。测试确认 A 过期后 B 获得 generation=2，且未完成 tool-use 的 terminal guard 返回 null。尚未运行真实 harness/外部工具的重复副作用端到端复现，不将重复发送邮件/写文件报告为已证实事实。 |
| Node 无周期 reaper | 此 control-plane runner 的 disposal 无 retry 调度，已确认。仓库另有 managed-runtime-host orphan reconciler 和 managed-runtime-node 工厂暴露的 reconciler，不能说全仓库没有；需按实际资源路径接入。所引 SessionRegistry.bootstrap 查的是旧 `sessions`，不是 `managed_session_executions` 的所有权恢复。 |
| provider TTL 能兜底 | `sandbox/src/recovery.ts:270-275` 仅对支持 runtime lease capability 的 adapter 续租；没有 lease capability 的 provider 不受这层保证。各 provider 的销毁/到期行为尚未实测。 |

## SQL 与恢复的具体要求

实际 coordinator + SQLite 证明：B 接管后 A 的 renew/settle 均返回 lost，B 的 owner 未被修改。源码的 claim 使用 revision CAS（checkpoint 模式额外有 session claim lock），renew/settle 使用 workspace/session/execution/attempt/owner/generation 等条件。这里已有保护，应保留，不能换成“先查再无条件写”。此测试未覆盖 PostgreSQL/MySQL 并发或真实数据库断网。

新 `release` 必须完整 fence CAS，且不能覆盖新 owner。settle 抛错可能是事务/网络结果未知，不应一概认定回滚：若先前已经成功提交，就不能再把它变成可重投。DB 不可用时，第二次 release 写入也可能失败；“settle 失败必定立即可领取”不成立，须保留 TTL 兜底。若原 attempt 还可能运行，立即过期更需副作用保护。

canonical evidence 应按 durable execution/source position（含 steering 消费归属）关联，不宜用“时间戳之后的全部事件”；输入排队顺序不等于执行顺序。没有 durable tool event 也不天然证明外部操作未发生，需要验证 dispatch 前持久化屏障，或记录“不确定已执行”，避免 event write 失败窗口绕过保护。

## 建议的最小分期

1. **先修可独立证明的生命周期缺口**：gate/runner cancel 的 attempt 身份校验；明确 attempt 结束时清理 pending cancellation；将失败 disposal 从 rejected Promise 改成可重试、可持久恢复、资源身份受保护的状态。保留 warm session 资源，不改变 global fatal 策略。
2. **补齐安全恢复再加速重投**：覆盖 sweep 与直接 claim 的证据判定，保留已提交终态快速恢复；工具 dispatch 前持久化边界、不确定副作用不重放；fenced release 与结果未知处理。故障注入必须包含 side effect 已发生但结果未提交、settle 提交后响应丢失、不同 owner 接管。
3. **增加阶段 watchdog 和资源 reconciler**：合法长工具/首 token 静默/启动/drain/publish 与真实 stuck 分别验证；持久化 disposal 重试、旧 generation 清理竞态、provider delete 超时及晚到完成。验收看规范输出、工具调用次数、真实资源生命周期，不只 Map size。

需要用户选择的实质方向：是否采用上述分期、保留未知 fatal 退出恢复，并把“物理单例”改为“单一有效 fence + 可追踪的最终回收”。如果必须保留任意 fatal 都不影响其他执行的目标，应另做进程隔离设计，而不是继续增加 global 吞错规则。

## 本次复现与交付范围

脚本：[issue-525-audit.mjs](./issue-525-audit.mjs)。Node `v24.18.0`、Effect `3.22.1`；7 个 characterization probes 全部满足预期断言。包含真实子进程异常、实际 pure policy、实际 coordinator SQL；部分 runtime/runner 方法原样抽取并注入最小依赖，明确不是完整服务测试。

```sh
npm install --prefix /tmp/oma-525-audit --ignore-scripts --no-audit --no-fund effect@3.22.1
OMA_AUDIT_DEPS=/tmp/oma-525-audit node docs/implementation/issue-525-audit.mjs
```

摘要结果：

```json
{"uncaught":{"caught":1,"releasedBeforeInterrupt":0,"releasedAfterInterrupt":1},"deadlineClamp":100,"staleGateReplacementSurvives":false,"pendingCancelSessions":100,"pendingPerSessionLimit":16,"destroyCallsAfterTwoAttempts":1,"leaseLostSandboxStillBound":true,"newOwner":"B","newGeneration":2,"staleRenew":"lost","staleSettle":"lost","probes":7,"passed":7}
```

本轮仅新增这份评估与复现脚本，未提交 commit，未创建 PR；无实现 CI 结果。未部署、未修改 CF 路径、未引入队列、未改源 repo 或其他 worktree。完整 fault-injection 矩阵和 provider 集成测试应在方向明确、实现完成后执行，不能用本次 7 个探针替代。
