# Note: 覆盖率门禁采用「每文件棘轮 + 登记地板」

Status: superseded by [2026-09-28-coverage-100-percent.md](./2026-09-28-coverage-100-percent.md)（缺口补齐后，棘轮被 vitest 原生阈值取代）

## Problem

规范要求覆盖率门禁是「每文件 100%」，并明确「禁止降阈值」。但本项目已有代码达不到：19 个源文件里 7 个是 0%，整体 50.16%（首次量测）。一个从第一天就永远红的门禁，按规范自己的说法会被学会绕过——「会误报的门禁比没有更糟」。

两条路摆着：把 19 个文件补齐到 100%，或者让门禁承认现状。前者意味着为 `AnnotatorBody`（500 行 React 组件）、两侧入口的 `apply()`、`host-api`、`session` 等补写大量测试——那是本项目自己的开发工作量，而不是「建立规范」这件事的范围。

## Decision

覆盖率门禁 = **每文件棘轮**，由 `scripts/verify-coverage.mjs` 在 `vitest run --coverage` 之后核对：

1. `tests/gates/coverage-baseline.json` 登记的文件，`lines` / `statements` / `branches` / `functions` 四项都必须 ≥ 登记值；
2. **未登记的文件按 100% 要求** —— 新代码不许继承邻居的欠账；
3. 登记了但已不存在的文件 → 红，逼着删掉那行；
4. 地板只能升；调低任何一个数字都算改门禁，必须配一条 note。

地板从一次真实运行生成（`Math.floor(pct * 10) / 10`，留 0.1pp 余量吸收 reporter 舍入差异），不是手抄。vitest 侧只负责把范围钉死在 `src/**/*.ts` 与 `src/**/*.tsx` 并输出 `json-summary`；判定权全在脚本里。

负控制按规范三步法实测过：

- 把 `src/client/session.ts` 的 `lines` 地板抬到 99 → `verify-coverage: 1 problem(s)` / `lines 36.66% < 99%`，退出码 1；
- 删掉 `src/client/AnnotatorBody.tsx` 的登记行 → 报 `lines 0% < 100% (unregistered file: must be fully covered)`，退出码 1；
- 回退基线 → 恢复绿。

## Alternatives considered

- **立刻补齐到每文件 100%** —— 未采纳（不是否决）。这是最终目标，但 7 个 0% 文件里 `AnnotatorBody` 是主要成本；把它当成「建规范」的一部分会让这次改动变成一个功能开发任务。棘轮让这件事可以按文件逐个推进，且每一步都不可回退。
- **不设覆盖率门禁，只跑 `vitest run`** —— 落选。那就等于放弃「覆盖率 = 死代码探测器」这个作用，之后加进来的文件默认没有覆盖要求。
- **vitest 内置 `thresholds.perFile`** —— 落选。它只接受一个全局数字，对 19 个文件意味着门槛降到最低那个文件（0%），门禁名存实亡；要分文件设阈值就得自己写判定。
- **收窄 `coverage.include`，把难覆盖的 UI 文件排除在外** —— 落选，且被 `coverage-contract.spec.ts` 明令禁止。这正是「把门禁调绿」而不是「把代码做对」。
- **只设全局阈值（如 45%）** —— 落选。全局数字可以靠某个文件的暴涨来掩盖另一个文件的暴跌，与「每文件」的意图相反。

## Consequences

**换来**：门禁第一天就是绿的、可执行的；历史债被逐文件登记，不再隐藏；新文件自动按 100% 要求；地板只降不升这件事有测试兜底。

**付出**：`coverage-baseline.json` 是一份需要维护的事实清单——删源文件必须同步删行（否则红），加源文件要么覆盖到位、要么显式登记一个地板。

**遗留**：整体覆盖率仍是 50.16%，`src/index.ts`、`src/client/index.tsx`、`src/client/AnnotatorBody.tsx`、`src/client/host-api.ts`、`src/client/locales.ts`、`src/client/styles.ts`、`src/host/guidance.ts` 七个文件为 0%。它们已记录在 `AGENTS.md` §7 的缺口清单里，后续按文件推进时只改地板、不删规则。
