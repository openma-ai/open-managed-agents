# Node 异常体系与 Effect 迁移评估

> 历史审查记录：以下诊断/探针以 `edde3af523b0e2896d018d11248f99c3d8bc5a3e` 为基线，不代表实现后的现状。用户已批准一起修复；当前交付边界见 [实现说明](./issue-525-implementation.md) 与 [provider 语义核对](./issue-525-provider-semantics.md)。

## 结论

**建议增量迁移 Node 执行控制内核到 Effect；不建议全仓改写，也不建议把加上 Effect 当成异常体系已解决。**

当前代码已经使用 Effect `3.22.1`。应先统一错误分类、重试安全和执行身份，再把 service/attempt 的生命周期真正结构化。对外维持现有 Promise Ports、HTTP/事件契约；SQL CAS、持久恢复和 provider 回收继续承担跨进程正确性。未知进程级 fatal 保留退出与外部重启。

本轮范围：Node HTTP/服务启动关闭、SQL 边界与协调器、worker/runtime/runner、模型/工具/MCP、通用 managed-runtime-host、sandbox Effect kernel、scheduler/supervisor。检查了相关源码与现有测试，并对关键边界做隔离故障注入。不是逐个 provider 的线上认证，也未审查整个 UI/SDK 的所有异常。以工作树 `edde3af523b0e2896d018d11248f99c3d8bc5a3e` 为代码基线；原任务的 main 比较与工作树信息见 [前次评估](./issue-525-assessment.md)。

## 现有体系：不是从零引入 Effect

| 层 | 现状 | 应承担的责任 |
|---|---|---|
| HTTP/application | domain exception → 4xx；Hono 最后处理器 → 500 | 结束本次请求、返回稳定公开错误，不据此重跑执行 |
| 模型/工具 | OmaError、ToolFailureError、harness retry、模型侧 error result | 区分配置/鉴权/限流/工具反馈，不重复非幂等操作 |
| SQL adapter | Effect TaggedError + Schedule retry + timeout race | 保留提交确定性；只有满足安全条件才 retry |
| SQL coordinator | Promise 内使用 Effect；revision/attempt/owner/generation CAS | claim/renew/settle 和跨进程恢复的事实来源 |
| Node worker | Effect sleep/fiber + Promise `#run` + 手工 cancel | 接单、attempt 归属、heartbeat、settle、停机 |
| Node runtime/runner | Promise、session maps、AbortController、try/finally | 工具/模型/输出与资源生命周期；区分 session 资源和 attempt 绑定 |
| managed-runtime-sandbox | 已有 `tryPortPromise` / `runPortEffect` | 可取消 provider IO 与 Promise 兼容边界 |
| managed-runtime-host | 手工 heartbeat/fence/finally + durable orphan port | workspace/output/sandbox 事务与最终回收 |
| process | unhandledRejection/uncaughtException 共用 net | 记录无法归属的故障，按故障边界退出恢复 |

直接依赖 Effect 的核心包有 `sql-client`、`session-runtime-sql`、`control-plane-node`、`managed-runtime-sandbox`；`apps/matter` 也已使用它。因此问题是“哪些边界要深化使用”，而不是是否新增一个从未用过的框架。

## 具体发现与优先级

### A. 应先于迁移处理的安全/语义问题

**A1 — 写入断线重试没有区分提交结果未知。已隔离复现。**

`packages/sql-client/src/db-errors.ts:73-84,206-240` 把 ConnectionLost 与回滚类故障一起自动 retry；`adapters/postgres.ts:125-174` 的 run/first/all/batch 都使用该包装，MySQL 的 batch 也存在 COMMIT 失败后重试整个事务的路径。实际 PostgresSqlClient 接一个“写已生效、响应抛 CONNECTION_CLOSED”的假 driver，观测 `calls=2, committed=2`。这验证 adapter 策略会重放，不等同于真实 PostgreSQL 网络故障复现。

不是所有写都有幂等协议，例如 `vault-store-sql/src/index.ts:134-139` 的无条件 revision 增量。需区分发送前失败、数据库确认回滚、提交结果未知；后者要读回/幂等键/CAS 恢复，不能只看 ConnectionLost 标签。Effect 的 retry 能执行策略，不能证明策略安全。

**A2 — 超时不等于取消，不等于回滚。已隔离复现。**

`db-errors.ts:254-312` 的 timeout race 只停止调用者等待。实际 withDbBoundary 返回 Timeout 后，原 Promise 仍可完成写入。换成 Effect.timeout 也不能强制取消不响应 AbortSignal 的第三方操作。

执行层需记录 outcome certainty；未知结果不得作为“肯定未执行”重投。SQL/工具侧必须有对应取消、幂等或 fencing 协议。

**A3 — 输出回调从 session map 动态取 fence。已方法级复现。**

`node-managed-session-runtime.ts:331-339` 的 output callback 每次输出时读取 `this.executionFences.get(input)`，而非绑定原 attempt。Map 从 A → B → 删除，旧 callback 实际得到的 fence 依次为 A、B、undefined；`:687-690` 仅在有 fence 时向 projection 传它。

这证明身份错配的局部条件，不宣称已复现真实 provider 并发或生产越权提交。应捕获原 fence 对象（heartbeat 仍可原地续期），attempt 结束后显式关闭输出能力，并验证晚到输出不会借用新 owner 身份。Scope 解决生命周期，不能替代身份绑定。

**A4 — 业务“fatal”与进程“fatal”混用；Node 的模型重试分类不一致。已函数级复现。**

`shared/src/errors.ts:49-59` 将 ConfigError/AuthError/PaymentRequiredError 定为不能靠重试解决。Node runner `:978-985,1292-1295` 只把 ConfigError 识别为不可重试；当 agentEventCount 未变时，AuthError/PaymentRequiredError 仍可能进入最多三次 harness retry。应统一内部不可重试分类，并称为 non-retryable，避免与进程崩溃混淆。

**A5 — process net 对 uncaughtException 也套用了 DB 放行表。已实际函数复现。**

`db-unhandled-rejection.ts:26-56` 共用处理函数；production 模式下传入 `uncaught_exception + Timeout` 会 fatal log 但不 exit。错误类名不足以证明进程状态可继续使用。应区分已归属 operation 的可恢复错误与真正逃逸到全局的异常；不能只扩大 allowlist。相关 #524 的请求取消修复应独立保留，不作为全局吞错的证明。

### B. 最适合用 Effect 改善的生命周期问题

**B1 — Effect 外壳没有形成完整的 service/attempt 任务树。已局部 worker 复现。**

`node-session-execution-worker.ts:309-334` 用 runSupervised 启动独立 active/heartbeat，`#run` 本身仍是 async Promise，tryPromise 没把 signal 传入实际运行。`:137-142` stop 只中断 poll fiber；active finally `:314-316` 仍调用 `#pollInBackground`，`:481-491` 无 stopped gate 又开始 poll。受控 coordinator/runtime 下，stop 后仍成功执行排入的第二项任务。

需要 service Scope 拥有 poller 与 attempt 子 fibers，stop 首先关闭 admission，再按期限停止/等待 attempts，最后释放 DB 等依赖。不能在外面套 scoped 而保留散落的 runFork。

**B2 — runner 有保护区之前的资源获取，也有晚到资源泄漏。后者已片段级复现。**

runner `:733` 注册 controller、`:768` 启动 provider heartbeat、`:797` 创建 runtime、`:810` broadcast，保护 try 在 `:814` 才开始；这里有阶段注入候选。前次评估仅否定了“budget gate 注册在 try 前”，没有否定这些更早的 controller/heartbeat 窗口。

`:915-926` 用 Promise.all 并发 buildModel/buildTools；tools 完成后才给 turnTools 赋值，`:1112-1114` finally 仅清理已赋值的 tools。模型先失败、tools 后成功时，片段复现结果为 `lateToolsAcquired=true, disposed=0`。

每项 acquire 成功立即建立 release 责任；并发失败必须等待已拥有子任务或接管晚到的 acquire 结果。把 Promise.all 换成 Effect.all 而不传取消、不处理晚到返回值，仍会泄漏。

**B3 — Scope 不能终止任意外部 Promise。已 Effect 3.22.1 语义复现。**

包在 scoped/tryPromise 中的操作忽略 AbortSignal 时，interrupt 后 finalizer 已执行，原 Promise 仍能随后写入。前次子进程复现也证明 detached uncaughtException 被吞，不会自动关闭 scope。迁移要求所有异步工作有归属，IO 尽可能支持取消；不支持取消的端口要显式安排晚到结果处置与持久隔离。

`acquireRelease` 的 acquire/finalizer 有不可中断语义，不能不加区分地把无期限远程创建/删除塞进去。需要给远程操作期限与结果未知协议，保留 orphan 记录，而不是让 service shutdown 永久等待。

**B4 — supervisor 与 Promise 边界会丢失失败语义。已实际函数复现。**

- `supervised-fiber.ts:12-21` 把 typed failure 和 defect 记日志后转成功：两类 probe 都是一次错误回调、Fiber Exit.Success。对仅需隔离错误的后台工作这可能是有意设计，但不能用这个 join 结果证明 attempt 成功，也不能让关键循环悄悄停止而没有重启/健康状态。
- `managed-runtime-sandbox/src/effect-kernel.ts:43-49` 从组合 Cause 优先取第一个 failure；当主操作 failure + cleanup defect 同时存在，调用方只看到主错误。保留错误 identity 的兼容目标合理，但完整 Cause 必须另行记录或附带，不能遗失清理失败证据。SQL 边界存在类似 first-failure 解包。

**B5 — service shutdown 还没有完整的有界收敛协议。静态检查。**

`lifecycle.ts:51-67` 逆序清理并继续处理单项失败，是已有良好基础；但等待没有期限。`serve.ts:57-68` 的 signal handler 先 controlPlane.stop 再 exit，未先调用 server.close；stop rejection 的链也未显式处理。加上 B1 的 stop 后 claim，可能在 DB/资源关闭期间仍有工作。

应明确停止接收 HTTP/任务、等待或取消 in-flight、保存待回收责任、关闭依赖、到达停机上限后退出的顺序。正常 SIGTERM 的 drain 与未知 uncaughtException 的退出路径必须区分，不要要求已失去可靠性的进程执行复杂异步恢复。

### C. 保留和复用的已有设计

- SQL coordinator 有 revision/fence CAS；claim 后可找回同 owner/attempt 的结果（`coordination.ts:568-569`），settle 可读回自己的终态（`:1056-1069`）。不要因 A1 就把所有 SQL retry 一概删除，要按 operation 保留安全恢复。
- `committedExecutionTerminal` 已防止最终 idle 已提交的执行再次进入 harness；缺口是未完成副作用的恢复证据，不能把两者混为一谈。
- `managed-runtime-host/src/host.ts:846-925` 已有销毁失败转 durable orphan、凭据 revoke 失败阻止保留 runtime 的机制。后续应复用其资源协议，避免另造仅内存的 retry map。workspace/output/fence release 中部分 best-effort catch 需要明确补偿责任与可观测性。
- 工具失败以模型侧 error result 返回通常是正确语义，不能为统一 Effect 而将普通工具失败全部升级为 session/进程失败。
- Node scheduler 已有 Cron 的 catch/protect；HTTP routes 已有领域错误到状态码的映射。优先保留成熟边界，不因存在 catch 就逐个改写。
- MCP/HTTP/fetch 和 OAuth refresh 的 signal、body 生命周期、deadline 仍需逐层接通；这是 adapter 合同，不是 Scope 自动提供的能力。

## 建议的统一异常合同

| 类别 | 谁处理 | 默认动作 |
|---|---|---|
| DomainRejected / 配置、鉴权、支付不可用 | API 或 attempt | 返回明确失败，不重试，不退出进程 |
| DependencyUnavailable / 限流 | operation owner | 在预算内且证明可安全重复时重试；尊重 Retry-After |
| ToolFailure | harness | 作为工具结果交给模型；是否后续调用由显式策略决定 |
| UserCancelled | attempt | 结束本次执行、清理；按现有公开事件语义反馈 |
| LeaseLost | attempt | 撤销旧执行与输出权限；不以旧 fence 覆盖新 owner |
| OperationTimedOut | operation owner | 按阶段处理；单独判定底层结果是否已知 |
| OutcomeUnknown | recovery/coordinator | 读回、幂等对账或中断待核实；禁止盲目重放 |
| CleanupFailed | resource lifecycle | 保留主错误与清理错误；持久化待回收责任 |
| Defect（明确属于受管任务） | supervisor | 失败该任务并记录完整 Cause；判断是否污染共享状态，不自动无限重试 |
| 未归属的 process fatal | process/外部监护 | 最小可靠记录后退出，由 Docker/systemd 重启 |

不要用单个 `retryable: true` 代表全部判断。决策至少依赖 **错误类别、执行阶段、是否可能已产生副作用、幂等/读回能力、重试预算、当前 fence**。错误 metadata 应带 workspace/session/execution/attempt/owner/generation、operation/phase、cause 和 outcome certainty；公开事件仍按现有 wire contract 映射，避免把内部字段和敏感错误原文暴露给客户端。

预期失败进入 Effect 的 typed E；未知编程缺陷保持 Cause.Die；取消保持 interruption；只在明确边界转换。`Effect<…, unknown>` 在最外部 SDK 接口处可作为临时入口，内部应尽快 normalize。不要 catchAll 后无条件 succeed，也不要到处 runPromise/runFork，把业务重新切回无归属 Promise。

日志/metrics 的失败不能改写业务结果。当前 `sql-client/db-errors.ts:278-289` 在 finally 调日志，若注入 logger 抛错会覆盖结果；需要 no-throw 观测边界，同时保留 primary 与 secondary causes。

## 迁移边界与实施顺序

### 第一步：固定语义与回归证据

先修 A 类问题及 B1/B2 的确定性缺口，允许继续使用 Promise；同时引入统一 operation policy 和 fault-injection 测试。拆开“正确性修复”与“框架重构”，让 review 能看出行为变化。对 settlement + lane hold 的独立写入（`coordination.ts:1045-1069`）补响应丢失测试，验证终态读回是否遗漏 hold；目前这是待复现的静态风险。

### 第二步：以 Node attempt 为第一个完整 Effect 单元

目标形状：

```text
Node service scope
  ├─ poller（停止接单受统一开关控制）
  └─ attempt scope（不可变 attempt 身份）
       ├─ heartbeat / phase watchdog
       ├─ startup / model / tools / harness
       ├─ drain / output / checkpoint
       └─ scope 关闭：撤销绑定、停止子任务、交接回收责任

SQL coordinator + durable resource records：跨进程所有权与恢复
Promise/HTTP/provider Ports：边界适配，不改变公开协议
process fatal：外部监护重启
```

采用 scoped/forkScoped、明确的 Exit/Cause 处理、有限 retry Schedule；此阶段保持已有超时行为。新增阶段 deadline/watchdog、缩短期限或扩大中断范围，必须等下一阶段的安全恢复门禁通过后启用，防止自然 lease 过期触发不安全接管。Session 的 warm sandbox/workspace 单独管理，不跟 attempt scope 一起无条件销毁。先保持仓库已锁定的 Effect `3.22.1`；升级 Effect 主版本应另立改动，避免把版本升级与异常语义迁移混在一起。

### 第三步：逐层接通取消与持久恢复

审查 provider create/destroy、模型流、MCP body、OAuth、工具子进程的 AbortSignal/close 合同；加入 late-acquire 回收。然后完善不重放副作用的 claim/sweep/release 协议、durable orphan reconciler，最后增加阶段 watchdog。不会为了这次迁移修改 CF SessionDO、公开 SDK/CLI 或引入外部队列。

独立 review 补充：现有 orphan 协议依赖已知 sandbox lease/runtimeId（`runtime-resource-contract/src/orphan.ts:19-25`），host 在 acquire 返回后才持有 lease（`managed-runtime-host/src/host.ts:464`）。需加入创建前 allocation intent、按 generation 关联的幂等创建/查找或经验证的 provider TTL，覆盖“创建已生效但 handle 尚未登记”和“enqueue 前崩溃”的窗口。没有查找或可靠 TTL 的 provider 不能承诺自动回收。另 `sql-client/adapters/cf-d1.ts:7-16` 共用 driverRetry，CF SessionDO 共用 SQL execution store；Node 范围应通过 policy 注入或 CF 兼容门禁落实，不能仅以未改 CF 文件为依据。具体分期与验收以修订后的[异常处理总规划](./issue-525-exception-handling-plan.md)为准。

## 验收标准

空上下文 reviewer 补充了两条必需边界：结果未知在工具包装/确认执行阶段不能降级成普通模型错误，须防止同 attempt 再次副作用调用；ACP 工具在原生进程执行且通知可能晚到，宿主工具屏障不足以覆盖，需 prompt 前持久意图或原生协议保证。对应策略、能力矩阵和故障场景已纳入[总规划](./issue-525-exception-handling-plan.md)，不能只验证 claim/recovery 后宣称防重放完成。

1. start/prepare/model/tools/harness/drain/publish/settle 各阶段失败，attempt 资源责任可追踪；晚到 acquire 必须释放或进入持久 orphan。
2. `stop()` 后不再 claim；数据库关闭前 attempt 已停止或被明确交接。停机与 finalizer 有预算，不能无限等待。
3. A 丢失 lease、B 接管后，A 的晚到输出/cleanup 既不能借用 B fence，也不能变成 unfenced 写入。
4. 合法静默工具、首 token 长等待与真正 stuck 分别测试；取消后外部工作仍完成的情况必须进入 unknown/对账路径。
5. 写提交后响应丢失、timeout 后晚到提交、非幂等工具结果未落盘：不得未经证明地重跑。
6. auth/payment/config 不重试；限流/可回滚 transient 故障按有限策略重试；normal tool failure 仍能反馈给模型。
7. 同时发生主错误、cleanup 错误、日志错误时，主结果和全部诊断证据不丢失。
8. 单机真实进程 crash/restart 后从 SQL 恢复，验证工具调用次数、规范事件和 provider 资源，不只检查 Map size。

## 本轮证据与限制

新增三组可执行审查脚本：

- [Effect/process 边界探针](./issue-525-exception-probes.mjs)：5 个断言组，包含失败/defect 被 supervisor 转成功、组合 Cause 解包、无取消 Promise 晚到写、uncaughtException DB allowlist。
- [SQL/重试探针](./issue-525-io-probes.mjs)：Postgres adapter 的提交后断线假 driver、DB timeout 晚到写、Auth/Payment 分类。
- [runtime 生命周期探针](./issue-525-runtime-probes.mjs)：旧输出回调 fence、晚到工具资源、stop 后接单。

Effect 安装复用 `/tmp/oma-525-audit`；默认也可用 `OMA_AUDIT_DEPS` 指定位置。各脚本直接使用生产源码/方法抽取及最小依赖注入，均明确不是完整应用、真实 provider 或数据库网络故障的认证。本轮未运行完整仓库测试、未改生产代码、未创建 PR/部署；原有 [7 个探针](./issue-525-audit.mjs) 和 [问题评估](./issue-525-assessment.md) 仍单独保留。

参考：Effect 官方 [typed failures/catchTag](https://effect.website/docs/v3/error-management/expected-errors)、[defects](https://effect.website/docs/v3/error-management/unexpected-errors)、[fiber scope](https://effect.website/docs/v3/concurrency/fibers)、[resource Scope](https://effect.website/docs/v3/resource-management/scope)。上述能力适用于内部异步控制，不能替代 [Node 对 uncaughtException 的进程恢复要求](https://nodejs.org/api/process.html#warning-using-uncaughtexception-correctly)。本次具体行为以本地 `effect@3.22.1` 实测和源码为准。
