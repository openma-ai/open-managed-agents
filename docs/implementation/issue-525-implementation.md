# #525 实现与验证说明

## 结果与边界

本次把 Node 执行异常、队列消费、Session sandbox 引用和资源 worker 的所有权一起修复。采用已有 Promise/Effect 边界，不进行全仓 Effect 迁移。保留进程级未知 fatal 的退出行为，由部署的进程监护重启；没有启用 global log-and-continue，也没有把“模型无输出”作为失活证据。

用户确定的架构边界是：**attempt 只获得 sandbox 可用性和执行访问；Session 持有持久 handle；sandbox 生命周期和 lease 轮转由独立资源服务管理。** Node 给 harness 的访问对象不暴露 destroy、renewLease、suspend、resume、checkpoint 或 runtime capability；ACP 因而不会再自行续 sandbox lease。

后续合并的 catch-vs-crash 判定、#524 请求/响应流生命周期及 native SQL 合同见 [错误策略与验证映射](./issue-525-error-policy.md)。进程仍缓存 SDK 对象；持久身份和所有权以 SQL 为准，缓存丢失不授权重建或销毁。

## 实现

- `queue/consumer-runtime` 负责 poll、容量、正在处理的工作和 stop/drain，不导入 Session/domain。Node execution adapter 负责 canonical claim/renew/settle、interrupt 和 steering。
- Session admission 采用持久序号；同 Session 各 lane 在 Node 领取时串行。修复两个独立交错：候选读早于 mutex 版本导致双 claim，以及 held 输入合并 CAS 失败后仍完成源行。合并、源行完成和事件 held 标记现在位于同一条件事务。
- Session binding 与 resource inventory 持久化 allocation、provider namespace、值 handle、配置身份、readiness、管理 lease、使用记录和待回收错误。Map 只缓存客户端；新进程从数据库重新发现资源。
- 资源操作的管理 lease 与 attempt 的 canonical fence 分开。使用记录是远端操作未完成的证据，不是第二个 execution lease；失去 attempt lease 不会自动释放它。Session archive/delete 持久关闭 binding，迟到 create 无法复活 Session。
- 独立 sandbox lease worker 从资源 inventory 领取自己的 SQL lease，provider 续租不由 attempt 定时器驱动。它可以在 execution use 保留时维护资源，但不能清除 unknown use、派发业务或销毁资源。闲置窗口来自资源活动时间；不会因后台续租无限延长 idle retention。迟到的旧 worker 完成不能释放新 worker 的 claim。
- 资源回收只处理明确 retired、精确且隔离的 allocation；provider/namespace/actionable 条件在 LIMIT 前过滤，避免未知 intent 阻塞后续回收。删除异常保留责任，确认删除后才记 deleted。
- 调用前持久 dispatch 证据覆盖 opaque/native harness。未知写入或命令结果立即撤销后续派发能力；同批工具确认、MCP、普通工具和新消息均不能擦除证据。只读失败保留无变更语义；命令 SSE 缺少 exit 或 SDK transport error 不再伪装成成功结果。
- 终态恢复必须有先前持久 `drained`/`finished` 证据和当前 canonical fence。`idle` 本身不证明远端工作结束。只重做幂等的终态输出发布，不重跑 harness；旧 attempt 的 late finish 不能覆盖新 owner。
- 取消、输出、预算 gate、工具释放绑定原 attempt/client，避免旧 finally 清掉新 owner 的状态。停机先停止接单，再有界 drain/cancel，最后关闭资源维护和依赖。
- SQL driver 不再自动重试“连接丢失但提交结果不明”的写入。只有调用者明确保证可重放时才开启该重试；死锁/明确回滚的现有重试保留。

## 顺序与事务性

当前保证是 SQL 中的 per-Session admission 顺序与原子状态转换，不是所有 Session 的全局顺序。独立 producer 的先后由数据库序号分配的线性化点决定；墙钟不再承担顺序职责。

未来真实 MQ 可替换投递/唤醒机制，但仍需 outbox/inbox、Session 分区或顺序键、canonical DB CAS 和去重。broker ack 不能与任意远端 API 组成一个事务。这里没有宣称通用 exactly-once；结果未知的副作用保留为待对账，而非自动重跑。

## Provider 兼容性与剩余限制

逐个实现和官方语义见 [provider 语义核对](./issue-525-provider-semantics.md)。持久 handle 不承诺进程/内存连续，也不能撤销旧 SDK 已发送的请求。跨 owner 的 retained-resource 接管必须有资源使用已结束的证据；原有缺少 allocation 身份的资源不会被 orphan reaper 猜测删除。

local-subprocess 与 embedded LiteBox 有主机亲和性；控制平面内存不是恢复权威，但这不意味着整个系统的数据和资源无状态。LiteBox durable factory 使用 file-sync memory-store 模式，避免把仅创建时可配置的 host mount 当成可重连配置。

创建响应丢失、未知远端操作及无法确认的删除可能保留为待 provider 对账。没有通用的“清掉标记继续运行”按钮，也没有假定第三方调用支持幂等键。独立资源 worker 可重试续租/回收；资源不可恢复时是否由 checkpoint 替换，必须有明确恢复范围和证据，不是 attempt 重试策略。

## 验证证据

以下早期分组结果用于追溯；最终 source/数据库/CF 结果以 [PR #539](https://github.com/openma-ai/open-managed-agents/pull/539) 当前 head 的检查和说明为准。本地完整 Node 后续达到 990 通过、0 失败、1 个 installed-gh 环境 skip；与随后合入 main 的真实 artifact SIGKILL 测试整合时发现并修复了 post-terminal 恢复缺口，详见错误策略。完整 CF CI 暴露的五次取消 rejection 也已通过实际 workerd 复现并修复。

- 完整 Node suite：937 通过，1 个旧 DI fixture 失败，1 个环境相关 skip；失败 fixture 随后更新为真实 local factory capability。后续 54 项 control-plane、ACP、durable resource 与独立 lease 测试全部通过。
- 独立资源 lease、durable runner、background startup 与旧 checkpoint chaos：54 项通过；包含无 attempt 续租、新 worker 接管、旧完成 fenced、unknown use 保留和关闭挂起请求。
- runtime-sql：90 项通过，覆盖 claim 交错、held transfer 竞争与事务回滚、binding CAS、FIFO、scoped recovery。
- Daytona/LiteBox/BoxRun adapter：16 / 20 / 17 项通过，包含有远端效果后响应丢失、SSE 无终态、删除失败保留资源引用。
- 实际 workerd/D1：事件与 Session persistence 合同 2 项通过。SQL adapter 的 commit-response-loss 测试使用假网络边界，不能冒称真实数据库断线实验。
- 其他 provider/consumer/worker、migration、类型检查在各修改阶段通过；最终 CI 结果以 PR 检查为准。
- PostgreSQL/MySQL 实库在 CI 的 `db19946` 提交各 28/28 通过（非 skip）；后续新增 publication 合同至各 29 项，以最新 CI 为准。本机未安装 container runtime。云 provider 未使用真实账号做本轮故障注入，不能宣称完成云端认证。

两位空上下文 reviewer 独立发现并复现了 serial claim、held transfer、terminal recovery、reaper starvation 和 provider 吞错等缺口。其后续运行遇到模型额度限制；剩余整合由主 worker 完成，不能把后续改动标成已获独立 approval。

历史评估与 characterization probes 保留作审查证据，以原基线 commit 运行；它们不是当前实现的通过条件。没有合并、部署或发布动作。
