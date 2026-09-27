# Note: 覆盖率做到每文件 100%，并撤掉棘轮

Status: implemented

## Problem

上一轮按「最小门禁集」落地时，本项目达不到模板要求的「每文件 100%」：19 个源文件里 7 个是 0%，整体 50.16%。当时的折中是自建每文件棘轮（`scripts/verify-coverage.mjs` + `tests/gates/coverage-baseline.json`），把历史债逐文件登记下来、只许升不许降。

棘轮让门禁第一天就是绿的，但它有两处不满足规范：一是「每文件 100%」这条规则被改成了「不比上次差」，二是多了一套只有本仓库才懂的机械——一份需要人工维护的地板表，加一个 100 行的判定脚本。规范要求的是「宁可门禁少而每道真执行」，而不是「用自研机械把标准绕过去」。

## Decision

把缺口补掉，然后删掉自研机械：

1. 为 7 个 0% 文件与所有未满的分支补测试，源文件达到四项指标全 100%（测试数 66 → 206）。补测过程中一并修掉了下面这些**真实缺陷**，而不只是把行跑一遍：
   - `figure-dom.anchorAtPoint` 会把 `<defs>` 里的元素当成命中目标——那些元素从不渲染，用户不可能指到它们。改为跳过整棵非渲染子树（`isNonRendered`）。
   - `Canvas.toFigure` 在面板尺寸为 0 时会把坐标算成 `Infinity` 并提交出去。改为退化成 1:1。
   - `AnnotatorBody.parseAddressPath` 遇到畸形百分号转义会**抛异常**（同文件的 `parseSessionId` 却做了保护）。删掉两个手写解析器，改用两半共用的 `parseFileAddress`。
   - `annotation.describeShape` 的 `default` 掩盖了遗漏的 `MarkKind`；删掉后新增 kind 会在编译期暴露。
2. 清掉确认不可达的死分支：`Canvas` 的 `svgRef` 空检查与终点空检查、`render.ts` 的 pen 起始点守卫、`figure-dom.ts` 的文本回退、`session.ts` 的 `?? 'figure'`、`src/client/index.tsx` 的 `?? zh.title`。
3. 把 `AnnotatorBody` 的四个 state（`size` / `svgLayer` / `rasterUrl` / `rasterDataUrl`）合并成一个 `LoadedFigure` 联合类型。它们此前可以互相矛盾（有尺寸没图层、有 URL 没字节），矛盾组合正是那些不可达分支的来源；合并后这类状态无法表示。
4. 覆盖率门禁改回模板要求的形态：`vitest.config.ts` 里 `thresholds: { perFile: true, lines/statements/branches/functions: 100 }`，`include` 锁死 `src/**`。删除 `scripts/verify-coverage.mjs` 与 `tests/gates/coverage-baseline.json`，`coverage-contract.spec.ts` 改为钉住「阈值是 100、范围没被收窄」。

负控制按三步法复验：新建一个 `src/tmp-probe.ts` → `pnpm run test:coverage` 退出码 1，报 `Coverage for lines (0%) does not meet global threshold (100%) for src/tmp-probe.ts` → 删除后恢复绿。

## Alternatives considered

- **保留棘轮，把地板全部抬到 100** —— 落选。地板全是 100 时，棘轮与 vitest 原生阈值等价，却多出一份手维护的事实清单和一个自研脚本；这正是规范里「事实清单要么生成、要么验证」要避免的维护面。
- **只补测试，不动源码里的不可达分支** —— 落选。那样 100% 只能靠断言不可达代码达成，等于「为覆盖率写空测试」；规范明确要求未覆盖行先按死代码判断。
- **保留 `AnnotatorBody` 的四个 state，逐个给矛盾组合补测试** —— 落选。那会把「不可能发生的状态」写进测试资产，之后每次改动都要继续维护这些无意义用例。
- **把 `disabled` 属性一起删掉，让处理函数成为唯一判定** —— 部分采纳。保存按钮确实删掉了 `disabled`（否则 `run` 的守卫不可达），但 undo/redo 的 `disabled` 保留了：键盘路径本来就能绕过它，守卫因此仍然可达，界面也能保住「没得撤销时置灰」的提示。
- **对 `no-unbound-method` 加行内抑制** —— 落选。试过 `oxlint-disable-next-line`（两种写法都没生效），最后改成链式 `.call()`，既不触发规则也不用抑制。

## Consequences

**换来**：门禁回到规范原形，规则只剩一条「每个源文件四项全 100」；没有需要人工维护的地板表；`src/` 里没有已知的死分支；三个真实缺陷被修掉（`<defs>` 命中、零尺寸 `Infinity`、畸形转义崩溃）。

**付出**：测试从 66 条涨到 206 条，`tests/dom.ts` 多了一套 canvas / Image 桩；`AnnotatorBody` 被重构过一次（行为由 29 条组件级测试守）；以后新增 `src/` 文件必须自带满覆盖，否则门禁直接红。

**顺带确立的一条纪律**（已写进 `AGENTS.md` §9）：`disabled` 只做视觉提示，判定必须写在处理函数里且测试能走到；两处写死同一条件会让守卫永远不可达。
