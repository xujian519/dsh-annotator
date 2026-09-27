# dsh-annotator · 开发规范（AGENTS.md）

本文件是规范的**家**：一条规则只在这里写一次，别处只链接。每条规则都必须回答三件事——**家在哪、谁机器验证、理由记在哪**；三者缺一就不是规范。

来源：`~/projects/开发规范`（《AI 原生开发规范》调研 + 《新项目开发规范·最小门禁集》）。本项目按其 **Day 0 最小门禁集**落地，增量项见 §7。

---

## 1. 项目是什么

DSH（DeepSeek Harness）第三方插件包，一个 npm 包、两个半：

| 半边 | 入口 | 产物 | 运行环境 |
|---|---|---|---|
| Host | `src/index.ts` | `lib/index.js`（ESM） | Node，注册 HTTP 路由 + 智能体系统提示段 |
| Client | `src/client/index.tsx` | `lib/client.js`（单文件 CJS）+ `lib/client.pdf.js`（懒加载分块） | 浏览器，注册文档预览器与标注画布 |

`src/shared/` 是两半共用的纯逻辑。数据模型与侧车格式见 `src/shared/annotation.ts`、`src/host/sidecar.ts`。可标注类型：图片（PNG/JPEG/WebP/BMP/GIF/ICO）、SVG、PDF。

## 2. 不可违反的架构约束

**先读这一节再写代码。**

1. **Client 半边必须符合 DSH 动态客户端契约**：单文件 CJS；唯一副作用是 `window.__ModuleLoader__.load({id, factory})`；只允许 `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` 走 shell 的模块表，其余依赖全部内联（插件路由发不了字体等静态资产）。构建契约在 `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 与 `outputOptions.banner`。
2. **唯一的写入面是两个侧车文件**。标注绝不修改被标注的文档；写入路径一律由 `sidecarPaths()` 从文档路径推导（`<名含扩展名>.annot.json`、`<名含扩展名>.annotated.png`，分页再加 `.pN`），不接受调用方传入目标路径。读回走 `annotationCandidates()`：新名字优先，旧的主名名字只作回退，且文档必须指向当前文件（`annotationTargetsFigure()`）才被采用。
3. **插件路由自带守卫**。路由在 `/api` 之外，必须校验 `x-dsh-annotator` 请求头（再加 `Sec-Fetch-Site` 同源检查）；Client 与 Host 两侧的头名/前缀必须逐字一致（`src/host/routes.ts` ↔ `src/client/host-api.ts`）。
4. **注册即效应**。一切注册走 `ctx.effect()` / `ctx.inject()`，让卸载可逆；不要留下裸的 `addEventListener` 或全局可变态。
5. **边界 JSON 必须校验**。Host 收到的请求体一律经 `readAnnotationDocument()`（`src/host/store.ts`）校验后才能落盘，不做裸断言。
6. **误配置响亮失败**。两半都把自己的协作者当硬依赖：`inject` 声明 + `apply()` 里逐项检查，缺任何一个就抛 `missingService()`（`src/missing-service.ts`），绝不静默挂半个插件。没有例外。
7. **懒加载分块不得与主包共享模块**。模块加载器的 `require` 只解析模块表与已注册的分块，解析不了兄弟文件；一旦共享，主包就会静态 `require` 一个它拿不到的文件。构建期 `generateBundle` 拦住任何非入口、非动态入口的分块（`tsdown.config.ts`）。分块要用的主包能力（组件、已解析的字典）一律当 prop 传进去。
8. **重依赖只住在分块里**。PDF.js 及其数据只被 `src/client/pdf/` 引用，主包只能通过 `require.async("./client.pdf.js")` 触及它；分块内的 worker 与 cmap/字体/wasm 由构建期内联，运行时不得触网。分块内 PDF.js 版本必须与 shell 自有 PDF 预览同版（当前 6.3.289）。

## 3. 三个门禁

一条命令跑完，也可拆开：

```sh
pnpm run check          # = typecheck && lint && test:coverage
pnpm run typecheck      # 门禁 1
pnpm run lint           # 门禁 2
pnpm run test:coverage  # 门禁 3
```

| 门禁 | 命令 | 机器上保证什么 | 家 |
|---|---|---|---|
| typecheck | `tsc --noEmit -p tsconfig.json` | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noFallthroughCasesInSwitch` + `noImplicitOverride`；**spec 也在检查范围内** | `tsconfig.json` |
| lint | `oxlint . --type-aware --deny-warnings` | `any`=error、`no-floating-promises`、`no-unsafe-*`、`no-non-null-assertion`、switch 穷尽、`ban-ts-comment` | `.oxlintrc.json` |
| coverage | `vitest run --coverage` | `src/**` **每个文件、四项指标都 100%**（vitest 原生 `thresholds.perFile`） | `vitest.config.ts` |

`--type-aware` 需要 `oxlint-tsgolint`；**缺了它类型感知规则会静默失效**，所以它在 devDependencies 里，并由 §4 的负控制钉住。

两条配套纪律：

- `any` 用行内窄范围抑制 + 一句理由；**禁止文件级 / 全局关规则**。
- 规则冲突用「off + 注释理由」，不用静默。目前只有一处：`--deny-warnings` 之外的 CLI `--ignore-pattern 'tests/gates/fixtures/**'`（见 §4）。

**本项目的门禁没有例外**：覆盖率不设地板表、不排除任何 `src` 文件；`disabled` 属性只是界面提示，判定一律由处理函数里的守卫做出（见 §9）。

## 4. 负控制（门禁的灵魂）

> 会误报或空转的门禁比没有更糟——它读起来像保护，实际什么都没拦。

三个门禁各有一份「必须变红」的证明，在 `tests/gates/`：

| 证明 | 断言什么 |
|---|---|
| `typecheck-contract.spec.ts` | 五个严格开关全为 true；`include` 覆盖 `src` 与 `tests` |
| `lint-contract.spec.ts` | 用**项目自己的配置**跑 `tests/gates/fixtures/` 里的三份坏代码，必须非零退出且报出对应规则；三条规则在配置里必须是 error |
| `coverage-contract.spec.ts` | `perFile` 为 true 且四项阈值都是 100；`include` 未被收窄；`check` 仍串起三个门禁 |

**改任何门禁时按三步走**：引入一个回归 → 确认它变红 → 回退。覆盖率门禁的这一趟已按此法验证过（见 `docs/notes/implemented/2026-09-28-coverage-100-percent.md`）。

构建还有第四条门禁（不在 `tests/gates/` 里，因为它只在打包时存在）：**分块不得与主包共享模块**。证明方式是三步走里最便宜的一种——让分块 import 一个主包模块（例如给 `PdfBody` 加一句 `import { zh } from '../locales'` 并真实使用），跑 `npx tsdown`，必须看到 `client bundle: client.locales.js is a shared chunk` 且构建非零退出；删掉即恢复两个产物。这趟已跑过（见 `docs/notes/implemented/2026-09-28-pdf-annotation-in-a-lazy-chunk.md`）。

## 5. 覆盖率：每个文件 100%

`pnpm run test:coverage` 由 vitest 自己的 `thresholds` 判定：`include` 锁死 `src/**/*.ts` 与 `src/**/*.tsx`，`perFile: true`，四项指标都是 100。没有地板表、没有豁免名单、没有「先记下来以后再说」。

判定思路**不是**「补测试凑数字」，而是：

- 未覆盖的行**先当作死代码**：本项目 100% 的这一趟里，删掉/改写掉的死分支包括 `Canvas` 的 `svgRef` 空检查与端点位空检查、`render.ts` 的 pen 起始点守卫、`figure-dom.ts` 的文本回退、`session.ts` 的文件名 `?? 'figure'`、`src/client/index.tsx` 的 `?? zh.title`。
- **不可达的状态组合要让类型系统排除**，不是让每个消费者去防守：`AnnotatorBody` 的 `size`/`svgLayer`/`rasterUrl`/`rasterDataUrl` 四个 state 合并成一个 `LoadedFigure` 联合类型，才使得「有尺寸没有图层」这类分支根本不出现。
- 确实需要防守的分支，就补一条**走真实入口**的测试让它可达（例如 `disabled` 的按钮走键盘、`apply()` 缺服务走 stub composition）。

## 6. 决策记录（Agent Notes-lite）

非平凡变更（改行为 / 架构 / 契约 / 流程 / 格式）在同一批改动里带一条 note，放在 `docs/notes/{status}/{yyyy-mm-dd}-{topic}.md`，status ∈ `proposed` | `implemented` | `rejected`：

```markdown
# Note: <标题>

Status: implemented

## Problem
<不依赖解决方案也能读懂的问题>

## Decision
<已落地的现实，现在时>

## Alternatives considered
- **方案 A** — 为什么落选
- **方案 B** — 为什么落选

## Consequences
<换来了什么，付出了什么>
```

`## Alternatives considered` 是强制的：没记录打败过什么的决策会被重新争论。不许把一条 note 改成另一个决策——另写一条并交叉链接。

## 7. 本地窄、CI 全，以及尚未建立的部分

- **本地钩子**（`lefthook.yml`，`pnpm install` 时由 `prepare` 脚本装上）：pre-commit 只做秒级的「staged 文件 lint fix + 空白检查」，pre-push 只做 typecheck。**钩子里不跑测试，更不跑 coverage**——那会让每次提交都卡住，而卡住的门禁会被绕过。
- **CI**：`.github/workflows/ci.yml` 一条 job 跑 `pnpm run check`（ubuntu + Node 22）。

**已知缺口（诚实列出，不要当成已完成）**：

1. 无「注册即效应」的 dispose 断言测试——目前只靠 `ctx.effect` 的写法，没有测试证明卸载后注册真的移除。
2. CI 只跑单一平台与 Node 22，没有平台矩阵。
3. 缺陷类清单（正交结果独立上报、Dispose 必须达静止、临时文件私有目录等）尚未成文；本项目目前只有侧车写入这一处用到临时文件 + rename。
4. **真浏览器验证不在 CI 里**：这次 PDF 渲染链路的端到端验证跑在本机临时脚手架（真实 `lib/` 产物 + 真实宿主路由 + Chromium 151）上，没有进仓、CI 也没有等价物。CI 仍只有 §3 的三个门禁，加上 §4 那条构建门禁。
5. **PDF 目前是"每页一份批注"**，没有"多页合并成一份带批注的 PDF"；也没有把标注写回 PDF 注释对象（`/Ink`、`/FreeText`、`/Square`）。要做得另立决策。

## 8. 边界

- **always**：改行为带 note；改门禁带负控制；提交前跑 `pnpm run check`；断言外部状态（重读文件、重跑命令）而不是被测对象的自述。
- **ask first**：改 Host/Client 契约（路由前缀、守卫头、侧车文件名、`BODY_ID`）；引入新的运行时依赖（尤其会进 Client 单文件包的那种）；放宽任何门禁。
- **never**：提交 secrets；在 `lib/`（构建产物）里手改代码；绕过 `ctx.effect` 注册；把 `tests/gates/fixtures/` 从 lint 的排除名单里放出来；把覆盖率 `include` 收窄以藏文件。

## 9. 测试哲学

1. **真实现优先**：只 mock 昂贵 / 非确定边界（`fetch`、`ResizeObserver`、canvas 光栅化），其余保持真实——`tests/dom.ts` 装的是真 jsdom，`tests/routes.spec.ts` 起的是真 HTTP 服务器。
2. **测真实入口**：路由打真 socket，`apply()` 走 stub composition，组件的交互走真实指针 / 键盘 / input 事件。
3. **验证世界，不是自述**：断言磁盘上读回来的字节、断言子进程的退出码、断言发出去的请求体，而不是被测对象说它成功了。
4. **`disabled` 是提示，不是判定**：按钮的 `disabled` 只负责视觉反馈，真正的判定必须写在处理函数里，并且能在测试里走到（键盘、程序化调用）。两边都写死同一条件，会让守卫永远不可达——覆盖率门禁会立刻指出这一点。
5. **桩要与真身同形，尤其是回调**：把"真身会上报的副作用"从桩里省掉，就等于把一类 bug 藏起来。实例：`PdfBody` 曾把 `onDraftChange` 当内联箭头传下去，真身的 effect 依赖它的身份，于是"上报 → setState → 再渲染 → 再上报"变成死循环；jsdom 测试的桩不 setState 所以全绿，直到真浏览器里跑出 `Maximum update depth exceeded`（进程堆爆）。桩的回调要能触发父组件状态，并且要有一条断言钉住回调身份稳定。
6. **重渲染型的 UI 变更要有一次真浏览器验证**：单元测试用 jsdom 与替身跑逻辑，量不到"真实浏览器里到底渲染出什么"。真机脚手架（本机临时目录，不进仓）加载真实构建产物与真实宿主路由，跑完"打开 PDF → 渲染 → 翻页 → 画标注 → 保存 → 磁盘上出现侧车"这一整条链。
