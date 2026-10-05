# Note: 契约类型与哨兵常量下沉，去掉分块对主包组件的反向依赖

Status: implemented

## Problem

`AnnotatorBodyProps` 这组跨所有渲染体的 props 契约（以及 `Translate`、`BodyContent`、`SurfaceDraft`、`PageSurface` 等随附类型）寄居在 `AnnotatorBody.tsx` 里，而懒加载分块 `pdf/PdfBody.tsx` 要 `import type` 它——分块在运行时被禁止 import 主包模块（§2.7/§2.8），类型层却反过来指向主包组件文件，两个依赖规则打架。同一问题还落在 HTTP 边界：`GUARD_HEADER` 与 `ROUTE_PREFIX` 在 `host/routes.ts` 与 `client/host-api.ts` 各写一份字面量，靠 §2.3 的注释要求"逐字一致"，靠人记忆而非结构保证。`props.t?.(key, vars) ?? fallbackTranslate(...)` 这一两步回退在 `AnnotatorBody`、`MarkdownBody`、`LazyPdfBody` 各抄了一遍。

## Decision

- **契约类型独立成 `src/client/annotator-contract.ts`**。`AnnotatorBodyProps` 与随附类型、`Translate`/`TranslateVars` 全部移出 `AnnotatorBody.tsx`，由它和分块共同 `import type`；`AnnotatorBody` 仅 re-export，保持旧 import 路径可见。分块侧只 import 类型，运行时依赖图不因此触及主包组件。
- **哨兵常量独立成 `src/shared/http.ts`**。`GUARD_HEADER`、`ROUTE_PREFIX` 唯一定义在这里，Host 与 Client 都 import；`host/routes.ts` 再 re-export 以兼容既有引用。值不变，协议面不变。
- **`resolveTranslate()` 替代三处手写回退**。`props.t?.(...) ?? fallbackTranslate(props.localeId ?? 'zh', ...)` 统一收进 `annotator-contract.ts`，三个调用点各少一层心智负担。
- **构建期分块门禁不受影响**。`annotator-contract` 在主包侧被运行时引用（`resolveTranslate`），分块侧只有类型 import，`generateBundle` 的"分块不得与主包共享模块"检查照常通过。

## Alternatives considered

- **把契约放进 `src/shared/`** —— `shared` 目前是两半纯逻辑的家；props 契约带 `SessionsLike`、React 无关的 TS 类型，放进 `shared` 会让 Host 半边也看到浏览器专用的概念面，边界更脏。
- **继续让 `PdfBody` 反向 import `AnnotatorBody`** —— 类型能过编译，但任何"给 AnnotatorBody 加一个运行时依赖"的改动都会让分块在构建期被共享模块拦下；契约下沉后这个红区消失。
- **把 `GUARD_HEADER` 放到 `shared/address.ts`** —— address 是文件地址解析，放 HTTP 头常量语义错位。

## Consequences

- 改 props 契约只动 `annotator-contract.ts` 一个文件，主包与分块不再需要同步改两处。
- `GUARD_HEADER`/`ROUTE_PREFIX` 改值只会是一处改动，§2.3 的一致性从"注释要求"变成"结构保证"。
- 新增校验：typecheck、lint、`pnpm run test:coverage`（`annotator-contract.ts`、`http.ts` 均 100% 覆盖）、`pnpm run build` 全绿。
