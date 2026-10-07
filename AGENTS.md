# dsh-annotator · 开发规范（AGENTS.md）

本文件是规范的**家**：一条规则只在这里写一次，别处只链接。每条规则都必须回答三件事——**家在哪、谁机器验证、理由记在哪**；三者缺一就不是规范。

来源：`~/projects/开发规范`（《AI 原生开发规范》调研 + 《新项目开发规范·最小门禁集》）。本项目按其 **Day 0 最小门禁集**落地，增量项见 §7。

---

## 1. 项目是什么

DSH（DeepSeek Harness）第三方插件包，一个 npm 包、两个半：

| 半边 | 入口 | 产物 | 运行环境 |
|---|---|---|---|
| Host | `src/index.ts` | `lib/index.js`（ESM） | Node，注册 HTTP 路由 + 智能体系统提示段 |
| Client | `src/client/index.tsx` | `lib/client.js`（单文件 CJS）+ `lib/client.pdf.js`（懒加载分块，含 PDF.js 与 pdf-lib） | 浏览器，注册文档预览器与标注画布 |

`src/shared/` 是两半共用的纯逻辑。数据模型与侧车格式见 `src/shared/annotation.ts`、`src/host/sidecar.ts`；行级差异见 `src/shared/text-diff.ts`。可标注类型：图片（PNG/JPEG/WebP/BMP/GIF/ICO）、SVG、PDF、**HTML**（`html`/`htm`：在固定 1024px 宽、禁脚本的渲染面上标注，每条标注额外记下它落在哪个元素上；渲染与元素锚定在 `src/client/html-dom.ts`）。另有 **Markdown（`md`/`markdown`）**：不标注、只编辑——预览里改源文本，改动作为 unified diff 送进会话，**插件不写这个文件**（写入面仍只有那两个侧车，见 §2.2）；正文在 `src/client/markdown/`。

PDF 是**整份文档一份标注**：`figure.pageCount` 记页数，每条 mark 用 `page` 记自己在第几页，坐标以那一页的页面单位（PDF 点）计；保存时浏览器半边把标注写成**原生 PDF 注释对象**（`/Ink` `/Square` `/Circle` `/Line` `/FreeText`，各自带自绘外观流）并写出一份 `<名>.annotated.pdf`，会话收到的是这一份副本作为附件（外加每页的标注位图与文本清单）。分块内代码分布：`pdf/runtime.ts`（PDF.js 接缝与每页视口变换）、`pdf/annotate.ts`（pdf-lib 写入器）、`pdf/PdfBody.tsx`（文档级控制器）。

## 2. 不可违反的架构约束

**先读这一节再写代码。**

1. **Client 半边必须符合 DSH 动态客户端契约**：单文件 CJS；唯一副作用是 `window.__ModuleLoader__.load({id, factory})`；只允许 `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` 走 shell 的模块表，其余依赖全部内联（插件路由发不了字体等静态资产）。构建契约在 `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 与 `outputOptions.banner`。
2. **唯一的写入面是两个侧车文件**。标注绝不修改被标注的文档；写入路径一律由 `sidecarPaths()` 从文档路径推导（`<名含扩展名>.annot.json`，以及 `<名含扩展名>.annotated.png`／PDF 的 `.annotated.pdf`），不接受调用方传入目标路径；写入的产物种类必须与文档自身类型一致（`writeAnnotation()` 会拒绝错配）。**HTML 只写标注文件**：浏览器无法把渲染好的文档栅格化成图片，所以它的保存不携带任何 review 产物，`writeAnnotation()` 的 `review` 参数留空。读回走 `annotationCandidates()`：新名字优先，旧的主名名字只作回退，且文档必须指向当前文件（`annotationTargetsFigure()`）才被采用；PDF 在没有统一侧车时还会把上一版"每页一份"的文件读成一份文档（`readLegacyPages()`），只读不删。
3. **插件路由自带守卫**。路由在 `/api` 之外，必须校验 `x-dsh-annotator` 请求头（再加 `Sec-Fetch-Site` 同源检查）；Client 与 Host 两侧的头名/前缀必须逐字一致（`src/host/routes.ts` ↔ `src/client/host-api.ts`）。
4. **注册即效应**。一切注册走 `ctx.effect()` / `ctx.inject()`，让卸载可逆；不要留下裸的 `addEventListener` 或全局可变态。
5. **边界 JSON 必须校验**。Host 收到的请求体一律经 `readAnnotationDocument()`（`src/host/store.ts`）校验后才能落盘，不做裸断言。
6. **误配置响亮失败**。两半都把自己的协作者当硬依赖：`inject` 声明 + `apply()` 里逐项检查，缺任何一个就抛 `missingService()`（`src/missing-service.ts`），绝不静默挂半个插件。没有例外。
7. **懒加载分块不得与主包共享模块**。模块加载器的 `require` 只解析模块表与已注册的分块，解析不了兄弟文件；一旦共享，主包就会静态 `require` 一个它拿不到的文件。构建期 `generateBundle` 拦住任何非入口、非动态入口的分块（`tsdown.config.ts`）。分块要用的主包能力（组件、函数、已解析的字典）一律当 prop 传进去——PDF 正文的 `AnnotatorBody` 与"文档座位"（`DocumentSeat`：读、存、投递）就是这么过界的。
8. **分块只能经 `require.async` 加载**。除了动态导入那一条调用，入口里不允许出现任何指向分块的同步 `require` 或别名引用。rolldown 在分块的依赖图看起来有副作用时会额外插一条**急切**的 `require("./client.x.js")`（引入 pdf-lib 时就真的出现了）——浏览器工厂解析不了它，构建插件会把它剥掉并断言没有残留（`asyncChunkRequire()`）。分块的运行时代码只能引用 shell 的模块表（`react` 等）与它自己 bundle 进来的代码。
9. **重依赖只住在分块里**。PDF.js、pdf-lib 及其数据只被 `src/client/pdf/` 引用，主包只能通过 `require.async("./client.pdf.js")` 触及它；分块内的 worker、cmap/字体/wasm 由构建期内联，运行时不得触网。分块内 PDF.js 版本必须与 shell 自有 PDF 预览同版（当前 6.3.289）。分块打包的每个第三方包（PDF.js、pdf-lib、pako 等）的许可证都由构建期写进分块 banner，缺一份就让构建失败。
10. **HTML 渲染面必须是「禁脚本的同源沙箱 + 自带 CSP」**。`src/client/html-dom.ts` 把文档写进 `sandbox="allow-same-origin"`（**不给** `allow-scripts`）的框架，并在文档头注入 `default-src 'none'` 策略、剔除 `<base>` 与会刷新的 `<meta>`。三个后果都是设计的一部分，不是可以顺手的优化：（a）父页要读框架里的元素才能把标注锚到 `selector` 上，所以不能让沙箱把它变成不透明源；（b）框架里的东西**永不执行**——脚本、内联事件处理、`javascript:` 全部由沙箱保证不运行，因此这里不需要、也不允许用自研 sanitizer 来换安全；（c）渲染宽度固定为 `RENDER_WIDTH`（1024），元素自己的布局像素因此就是 mark 的坐标单位。**不允许**为了「让脚本驱动的内容也能标注」而加 `allow-scripts`、放宽 CSP 或改用 `srcDoc`/`blob:` 的非沙箱框架——那等于把任意 HTML 提升到应用源上执行。
11. **HTML 的产物只有标注文件**。渲染出来的文档无法栅格化（浏览器没有 DOM→图片接口，插件也不引第三方光栅器），所以 HTML 的保存不携带 review 产物、消息里没有图片附件；定位靠 `marks[].anchor.selector`，`points` 只作辅助。要加「带批注的 HTML 副本」是新增一种写入产物，先按 §8 单独拍板。

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

构建还有第四条门禁（不在 `tests/gates/` 里，因为它只在打包时存在）：**分块只能异步加载，且不得与主包共享模块**。两条证明都是"引入回归 → 变红 → 回退"：

| 回归 | 期望的失败 |
|---|---|
| 让分块 import 一个主包模块（例如给 `PdfBody` 加一句 `import { zh } from '../locales'` 并真实使用） | `client bundle: client.locales.js is a shared chunk`，构建非零退出 |
| 让入口与分块出现同步引用（例如把 `LazyPdfBody` 的 `import()` 改成顶层 `require` 等价写法，或让 `asyncChunkRequire()` 不再剥离急切 preload） | `client bundle: require('./client.pdf.js') would not resolve in the browser` 或 `has no generated import expression`，构建非零退出 |

第一条已跑过（见 `docs/notes/implemented/2026-09-28-pdf-annotation-in-a-lazy-chunk.md`）；第二条是引入 pdf-lib 时真实撞上的回归，剥离逻辑与残留断言见 `docs/notes/implemented/2026-09-28-pdf-annotated-as-one-document.md`。

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
5. **PDF 标注不做"烧进页面内容"的副本**，也不在宿主侧从 JSON 重新生成带批注的 PDF（`<名>.annotated.pdf` 完全由浏览器半边在保存时产出）。没有 PDF 文本层与连续滚动：一次一页。
6. **HTML 的渲染面是静态的，且比内置 HTML 预览弱一档**：框架不执行脚本、相对引用的图片与外部样式不加载（内置交互模式至少会打包 `script[src]`/`link[rel=stylesheet]`）。因此脚本渲染出来的内容在预览里是空的，标注也落不到它上面；要补相对资源得先引入一条能读兄弟文件的接缝（插件路由加只读模式，或注入 `remote.workspaceFiles`），那是 §8 的"改 Host/Client 契约"，要单独拍板。
7. **HTML 不做原位编辑与元素直接评论**：目前只有「画一条标注 + 元素锚定」，anno 式的"点元素写评论 / 直接改文字"尚未做，区域标注也不记录被框住的元素清单（`targetKeys` 那种）。

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

7. **单元测试看不见的失败模式，要在最外层入口上验**：断言产物本身，而不是断言自己的产物看起来对。实例一：构建产物的同步 `require("./client.pdf.js")` 让每个 jsdom 规格都全绿，只有把真实产物交给模块加载器时立刻炸；实例二：外观流里箭头的两条斜边少了 `m`，PDF 结构断言（对象、矩形、颜色）全部通过，只有用独立渲染器（PyMuPDF）画出像素才看得出来。所以验收链是：**独立解析器读结构 + 独立渲染器看图 + 真实浏览器走交互**，三样都过才算完。
