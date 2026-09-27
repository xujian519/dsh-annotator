# Note: 采用「最小门禁集」开发规范

Status: implemented

## Problem

本项目此前没有成文规范：没有 `AGENTS.md`，没有 lint，没有覆盖率门禁，`tsconfig.json` 的 `include` 只覆盖 `src` 与构建配置——**测试文件完全不在类型检查范围内**，可以引用已删除的导出而 CI 不红。规范来源是 `~/projects/开发规范` 下的两份文件（《AI 原生开发规范》调研 + 《新项目开发规范·最小门禁集》），后者明确要求 Day 0 只落地「三个门禁 + 负控制 + 元规则」，增量项按需再加。

## Decision

按模板的 Day 0 落地：

- **规范的家**：新建根 `AGENTS.md`。顶部先写不可违反的架构约束（DSH 动态客户端契约、只写侧车、路由守卫、注册即效应、边界 JSON 校验），再写门禁、负控制、决策记录与边界三档。每条规则只写一次。
- **门禁 1 typecheck**：打开 `exactOptionalPropertyTypes` 与 `noFallthroughCasesInSwitch`（其中 `strict` / `noUncheckedIndexedAccess` / `noImplicitOverride` 原本已开），并把 `tests/**` 纳入程序，测试从此受类型检查。为此补装 `@types/jsdom`。
- **门禁 2 lint**：选 `oxlint`（快、与 ESLint v8 配置兼容），配 `--type-aware` + `--deny-warnings`，规则集即模板给的那九条。
- **门禁 3 coverage**：见另一条 note `2026-09-28-coverage-baseline-ratchet.md`。
- **负控制**：`tests/gates/` 下三份 contract spec 分别钉住 tsconfig 开关与范围、lint 规则真的会红、覆盖率配置未被收窄。
- **接线**：`package.json` 的 `check` = `typecheck && lint && test:coverage`；`.github/workflows/ci.yml` 一条 job 跑 `check`。

**过程中门禁真的抓到了东西**（这是它值得存在的证据，不是装饰）：

1. 类型感知 lint 打开后报出 `src/client/render.ts` 的 switch **不穷尽**（漏 `'text'` 分支，靠 `default` 掩盖）；改为显式 `case 'text'` 后，将来新增 `MarkKind` 会在编译期暴露。
2. 报出 `src/client/index.tsx` 把 `ctx.get('sessions')` 的 `any` 直接交给预览体——加了 `BodyInjected` 接口显式定型。
3. 报出 `src/host/sidecar.ts` 一行从未使用的重复 import（死代码，删除）。
4. 报出 `SessionsLike.scope()` 的返回类型 `unknown | undefined` 里 `unknown` 已含 `undefined`。

## Alternatives considered

- **一次性照搬四项目全套**（权限沙箱三档、platform matrix、生成器新鲜度门禁、跨包去重门禁）—— 落选。模板自己写着「宁可门禁少而每道真执行，也不要清单长而全靠自觉」；本项目是单包 ~1500 LoC，多数条目没有对应风险面。
- **只写文档、不建门禁** —— 落选。这正是规范里点名的失败模式：deepseek-harness 把铁律写成散文却没配门禁，全仓审计发现被逐个击破。
- **用 eslint + typescript-eslint** —— 落选，但保留为可选等价物。oxlint 启动快一个量级（本项目全量 0.1s），类型感知由 `oxlint-tsgolint` 提供且实测有效；规则名与模板逐条对得上。
- **不用类型感知 lint** —— 落选。实测 `no-floating-promises` 在非类型感知模式下**完全不报**，`no-unsafe-*` 同理；那会是一道空转的门禁，比没有更糟。代价是多一个 `oxlint-tsgolint` 依赖。
- **把 `tests/gates/fixtures/` 留在主 lint 范围内** —— 落选。它装的是故意写坏的代码，留着意味着 `pnpm run lint` 永远红，而永远红的门禁会被学会忽略。改用 CLI `--ignore-pattern` 排除，并由 `lint-contract.spec.ts` 钉住这条排除本身。

## Consequences

**换来**：一条 `pnpm run check` 覆盖类型、lint、覆盖率；测试首次受类型检查；每条门禁都有证明它会红的负控制；改门禁这件事本身有据可查。

**付出**：多三个 devDependency（`oxlint`、`oxlint-tsgolint`、`@types/jsdom`）；`--type-aware` 让 lint 从 6ms 变成约 120ms（仍远快于 eslint）；为让 `.mjs` 脚本也受类型检查，`tsconfig` 开了 `allowJs` + `checkJs`。

**新增的约束**：往 `src/` 加文件必须同时满足覆盖率地板（未登记即要求 100%），这是有意的摩擦。
