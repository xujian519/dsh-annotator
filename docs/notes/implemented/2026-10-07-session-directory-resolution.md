# Note: 会话目录的解析（相对路径地址）

Status: implemented

> 关联：[2026-10-07-html-annotation.md](./2026-10-07-html-annotation.md)——本条是在真机验证 HTML 那条链路时撞出来的既有缺陷，图片/SVG/PDF 同样受影响。

## Problem

侧栏预览的地址形如 `dsh-resource://file/session/<sessionId>/<路径>`，其中路径可以相对；只有宿主能把它变成真路径，而宿主对"某个会话的工作区目录"一无所知——它得去问三个来源之一：活着的 Agent、落盘的会话头、登记了这个会话的工作区（`src/host/session-cwd.ts`）。

在本机 DSH `0.2.1-alpha.1` 上，这个解析**一律失败**：预览一打开就是 `读取标注失败cannot resolve this Session's directory for a relative path: …`，于是保存与读回全断（图片、SVG、PDF、HTML 都一样；只有绝对地址能用）。实测两个原因：

1. **三个来源在插件挂载时被捕获，其中两个那时还不存在。** 插件只 `inject` 了 `webServer` 与 `systemPrompt`（宿主平面最早就绪的两个），`sessionPersistence` 与 `workspaceRegistry` 在组合里排在后面。apply 时的探针输出：`[anno-debug] apply-time sources: {"agents":true,"sessionPersistence":false,"workspaceRegistry":false}`——捕获成 `undefined` 之后，路由再怎么调用都看不到它们（证据 A）。
2. **活会话的目录字段搬过家。** 0.2.x 的 `Session` 把创建元数据挂在 `session.header` 下（`SessionHeader.cwd`，证据 B），插件读的却是更早版本里的扁平 `session.cwd`，于是第一顺位来源即使有活会话也永远读空。

## Decision

- **三个来源按请求读取**：`apply()` 里只留一个 `sources()` 函数，路由每处理一次请求就调一次 `ctx.get(...)`。挂载晚的服务因此在自己就绪之后立即可见。
- **活会话按 `session.header.cwd` 读，并保留 `session.cwd` 作为回退**：一条 `??` 链同时兼容搬家前后两代 harness 形状；回退那一支有一条"只带扁平字段的活会话"的测试钉住，不是摆设。

## Alternatives considered

- **把 `agents` / `sessionPersistence` / `workspaceRegistry` 写进 `inject`**：落选。它们是**可选**来源（组合里少一个就少一条路，剩下的仍然工作，绝对地址更是完全不依赖它们）；声明成 inject 会让插件在缺任一服务的组合里干脆不挂载，把"降级"变成"全挂"，与 §2.6 的取舍方向相反。
- **只在 apply 时读一次并缓存在闭包里**（原实现）：落选，实测就是它坏的——顺序一变就永久失效，而且失效得很安静（只是每个相对地址都报同一个错）。
- **在会话头里另存一份工作区路径**：落选。那是把宿主本来就有的信息抄一份到插件的写入面里，多一处会漂的副本。

## Consequences

换来的：相对地址在"服务晚挂载"的组合里恢复，图片/SVG/PDF/HTML 的读写链路都跟着恢复——这是本插件在 DSH 0.2.x 上能否用的前提。

要认的：插件对两处宿主形状（`Session.header.cwd`、`sessionPersistence.stat().header.cwd`）的假设写进了接口注释；harness 之后再改形状，这里仍要跟着改一次。

## 证据

| 代号 | 内容 | 位置 |
|---|---|---|
| A | 隔离实例（DSH `0.2.1-alpha.1`）apply 时的探针输出：`agents` 可用，`sessionPersistence` / `workspaceRegistry` 不可用；修复后同一实例的 `GET /dsh-annotator/annotation?address=dsh-resource://file/session/<id>/report.html` 返回 `ok: true` 与正确路径 | 本机临时脚手架（不进仓） |
| B | `Session` 暴露 `readonly header: SessionHeader`，`SessionHeader.cwd` 是绝对路径；接口上不再有 `session.cwd` | `packages/core/session/src/session.ts:77`、`packages/core/session/src/types.ts:105`（上游路径相对 `~/projects/deepseek-harness`） |
