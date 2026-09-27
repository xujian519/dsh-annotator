# Note: 缺服务时响亮失败，不再静默挂半个插件

Status: implemented

## Problem

插件的两半此前都把协作者当「有则用之」：Host 半边在 composition 没有 `webServer` 或 `systemPrompt` 时静默不挂载，Client 半边在缺 `locale` / `documentPreviews` / `slots` 时静默跳过对应注册。后果是插件可以「进得去、只是什么都不做」——路由没注册、系统提示没注入，而宿主侧看不到任何错误，只有用户发现标注入口不存在。

规范把这一条列为铁律：误配置要响亮失败，绝不静默跳过缺失引用。此前它在本项目里被记成一条显式例外（理由是「插件是可选增强」），但那其实是在为「不做判定」找说法。

## Decision

两半都把协作者升级为硬依赖，并在 `apply()` 里逐项检查：

- Host：`inject = ['webServer', 'systemPrompt']`。
- Client：`inject = ['slots', 'locale', 'documentPreviews']`。
- 缺任何一项都抛 `missingService(name)`，消息文本收敛到 `src/missing-service.ts` 一处，两半共用。
- Client 半边原先用 `ctx.inject(['documentPreviews'], cb)` 等待注册表，改为顶层 `inject`：等待语义不变，但缺服务从「回调不执行」变成「apply 抛错」，可测也可诊断。
- 顺带删掉一处真正的死代码：`locale.bind(ns)('title') ?? zh.title`——shell 的 `translate` 以 key 兜底，永远返回字符串，`??` 右侧不可达。

`AGENTS.md` §2 里那条「显式例外」随之删除，改为一条无例外的硬约束。

## Alternatives considered

- **只声明 `inject`，不加显式检查** —— 落选。Cordis 的 `inject` 在服务始终缺失时只是「插件永不 apply」，同样没有错误信息；显式抛出才给出可诊断的原因。
- **保持可选挂载，只在文档里说明** —— 落选。这正是规范里点名的失败模式：把铁律写成散文而不做成判定。
- **只在 Host 半边改，Client 半边维持现状** —— 落选。两半是同一个插件，只有一半响亮失败会让「缺服务」这件事的表现取决于缺的是哪一个，更难排查。
- **让缺失的服务退化成空实现（no-op facade）** —— 落选。规范明确：schema 省略、过滤、facade 都不是 enforcement，判定必须发生在做决定的那一步。

## Consequences

**换来**：缺服务的 composition 会在加载阶段炸出带服务名的错误；两半行为一致；`missingService` 的文案只有一处。

**付出**：本插件不再能装进「没有 systemPrompt 或没有预览注册表」的组合——这正是 fail-closed 的代价，也是本轮明确选择的取舍。用户的 `desktop-runtime` profile 同时具备 `webServer`、`systemPrompt` 与 web-app 的槽位服务，不受影响（组合树已用 `dsh --profile desktop-runtime --dump-config` 核对）。

**验证**：`tests/plugin-host.spec.ts` 与 `tests/plugin-client.spec.tsx` 各有一组按服务名参数化的用例，缺任一服务都断言抛出对应文案；Host 侧另有经过 `apply()` 注册的真实路由处理器被真正调用一次的用例。
