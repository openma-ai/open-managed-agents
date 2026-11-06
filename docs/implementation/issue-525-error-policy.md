# #525：何时接住，何时退出

错误属于哪个 owner 只决定谁负责收尾，不能单凭“有 owner”断言进程安全。execution 与 sandbox/resource 保持两套 fencing；下面的错误策略不合并两者。

| 可执行判定 | 处理动作与边界 | 代码及回归证据 |
|---|---|---|
| 输入拒绝、业务失败、已知无副作用的工具失败 | 返回 owned 结果，不自动重跑业务，不退出进程 | runner/tool guard；`managed-session-durable-sandbox.test.ts` 的只读失败与工具派发测试 |
| 模型 SDK 的 `APICallError.isRetryable` 为 true，且本轮没有工具/provider 派发和 agent 输出 | harness 在固定次数和取消信号内重试。SDK 已包装的重试耗尽错误不再被外层展开重试 | `node-managed-session-runner.ts`；`managed-session-runner.test.ts` 的明确可重试模型错误 |
| 未分类 owned 异常，包括普通程序缺陷 | 不凭错误名称推断可重试；结束 attempt，保留 cause。有未决操作或 opaque harness 时保留 unknown 证据，停止后续派发。只有 scoped 状态和 canonical fence 仍可信时才局部结束 | runner + dispatch ledger；普通 `TypeError`/无输出错误不重试、unknown MCP/命令不重跑 |
| 明确共享协调不变量破坏 | `ProcessInvariantError` 是进程级升级信号；即使存在 attempt/resource owner 也退出。包含 cause/AggregateError 的包装不能把它降级。runner 不等待潜在挂起的 cleanup 才退出 | `process-invariant.ts`；worker 检测不一致 claim/重复 active identity；owned invariant 与 resource invariant 测试 |
| 关键 execution heartbeat supervisor 缺陷或意外完成 | 停止消费、撤销本进程 attempt 的执行权并退出。正常 stop 使用显式 interruption；循环内部已处理的有限 DB 故障不等于 supervisor 死亡 | `supervised-fiber.ts`、execution worker；defect、意外完成、正常 interruption 测试 |
| DB timeout/ConnectionLost 或远端写入、命令结果未知 | 不推断回滚，不自动重放。持久 dispatch/use evidence 保留；资源不可借用直到有明确完成/对账证据 | SQL retry、dispatch ledger、lifecycle；settle 响应丢失分已提交/未提交两例，观察器再抛错也不制造 ACK |
| execution lease 丢失 | 仅撤该 attempt 的派发与提交权。不能销毁 sandbox，不能清除未知使用记录；迟到输出/释放受原 fence 限制 | execution worker/runner；lease loss、new owner、旧 cleanup 测试 |
| sandbox 续租或删除的普通依赖失败 | 资源 worker 独立保留管理责任和失败记录，按资源策略重试；执行层只见可用性。不能把超时当作删除完成 | lifecycle、sandbox lease worker；独立续租、接管、失败重试与 stale completion 测试 |
| HTTP 请求取消或响应体中途失败 | signal 贯穿 Node binding/路由、上游 fetch、OAuth refresh；headers 返回后仍观察 body。错误留在请求/stream 上，断流不是成功 EOF。不在全局按网络错误名字豁免 | `http-mcp-proxy.ts`、`proxy/forward.ts`、两个 credential forwarder；握手取消、真实 socket 断开、SSE body 失败、OAuth 取消测试 |
| 未归属的 `unhandledRejection` / `uncaughtException` | best-effort 记录后 `exit(1)`；日志、metrics、错误序列化失败均不能阻止退出。由既有部署监护重启，不在进程内继续运行 | `db-unhandled-rejection.ts` 及现有 process-failure 回归 |

`ProcessInvariantError` 必须由知道不变量含义的代码抛出，不能根据“网络错误”“TypeError”等字符串自动判定共享状态损坏或安全。这次为 canonical ownership 和 critical supervisor 加了具体升级点；没有声称能自动识别任意第三方代码对共享状态的静默破坏。

清理失败与执行失败分别保留：清理仍尝试执行，原始业务错误保持顶层语义，额外错误进入 `cause`/`AggregateError`。consumer runtime 只管理本机 poll/capacity/drain，从不 ACK 或重试业务；`onError` 失败只能影响观测。

## #524 请求生命周期

采用其 signal 透传方向，未采用 global 网络异常豁免。两个 Node 入口均验证实际 fetch 收到的 Request 在取消后变为 aborted。测试保留 Request/signal 引用，使用明确的 dispatch handshake，不用固定 sleep 推测请求已发出。

`observeProxyBody` 从 headers 返回起观察 reader.closed，按 pull 读取，传播真实 body 错误并在取消时释放上游 reader；不会把 `TypeError: terminated` 改为成功的截断内容。真实 Node HTTP 测试覆盖上游 socket 中断和下游 client 断开。OAuth 在取消后不再派发业务请求，已经拿到的 token rotation 仍先持久保存。legacy refresh 拒绝时返回原 401，移除旧的同 token 再发一次行为。

负向对照：临时移除 `proxyUpstream` 中给 Request 的 signal 后，两个入口的 dispatch-handshake 取消测试均超时失败；恢复 signal 后通过。首次受限环境执行卡住后被终止，不计作这个负向证据；有效对照为之后完整执行的测试失败。

这些实验验证具体生命周期边界，**没有复现 #524 原作者生产实例的孤儿 undici rejection**，也没有把未复现的堆栈认定为所有 Node/Undici 版本的已解决问题。

## 实库 CI

`issue-525.postgres.integration.ts` 和 `issue-525.mysql.integration.ts` 各注册 28 项合同，实际创建 `postgres:16-alpine` / `mysql:8.4` 容器并使用独立 SQL 连接。没有 Docker 时失败，不 skip。覆盖持久 handle、两套 fence、unknown use、cleanup 责任、跨 lane FIFO/claim 竞争、held transfer 与独立资源 lease 轮转。

CI 新增并行 `database-contracts` matrix，结果接入必需的 `verify`，因此前置 browser/provider 用例失败也不会阻止实库合同执行。Node job 原有完整数据库集成仍保留。最终通过情况以 PR 当前 head 的检查为准。
