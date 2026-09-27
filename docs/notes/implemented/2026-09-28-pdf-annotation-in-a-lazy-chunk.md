# Note: PDF 标注：每页一份侧车，PDF.js 放进懒加载分块

Status: implemented

## Problem

项目目标是给图片、SVG、PDF、HTML、Office 文档做标注。图片与 SVG 已实现：浏览器半边拿到整份字节，渲染成位图或内联 SVG，画布坐标用图的固有像素，导出 PNG 与 Markdown 回填会话。PDF 不一样：一份文件有几十页，标注必须说明"第几页"；而解析 PDF 需要 PDF.js，它连同 worker、CMap、标准字体与 wasm 数据约 6.8 MB —— 塞进启动包会让每个会话都付这笔钱，而多数会话根本不打开 PDF。

## Decision

- **标注对象是"某一份文档的某一页"**。页尺寸用 PDF 单位（点）作坐标空间，标注在任何缩放与窗格宽度下都指向同一处；侧车文件名带页码（`<名>.pN.annot.json`），页与页互不覆盖，撤销历史也天然按页隔离。
- **渲染只存在于懒加载分块里**。`src/client/pdf/pdf.tsx` 是全包唯一引用 PDF.js 的模块，构建产出 `lib/client.pdf.js`；主包只在 PDF 正文挂载时才 `require.async("./client.pdf.js")`。这照搬了 shell 自己 PDF 预览的做法与模块加载器的分块契约（宿主只按 `client.<名>.js` 形状提供文件，不需要任何注册）。
- **worker 与数据全部内联**。客户端工厂没有模块 URL 可解析相对路径，所以构建期把 `pdf.worker.min.mjs` 以文本打进 chunk，运行时用 Blob URL 起一个 module worker；CMap、标准字体、wasm 目录同样在构建期内联为 base64，经 PDF.js 6 的 `BinaryDataFactory` 注入。打开 PDF 不触网。
- **分块不得与主包共享模块**。模块加载器的 `require` 解析不了兄弟文件，因此"两边共享一个模块"会让主包静态 `require` 到一个它拿不到的分块——这正是改动前那次构建的真实产物。构建期在 `generateBundle` 里检查任何既非入口又非动态入口的分块并让构建失败；分块自身要用的拷贝（如字典）由主包解析后当 prop 传进去。

## Alternatives considered

- **用 PDF.js 自带的 AnnotationEditor 当批注层** —— 它的类型只有 `FREETEXT / HIGHLIGHT / STAMP / INK / SIGNATURE`（实测枚举），没有箭头与矩形框；采用它等于放弃已有的 mark 模型、撤销重做与 sidecar 管线。
- **在 shell 的只读 PDF 预览上叠一层画布** —— 槽位系统一个 key 只渲染一个正文，工具栏槽位也放不下覆盖层；只能去猜 shell 的 DOM 结构，违反"注册即效应、不依赖他人私有 DOM"。
- **宿主侧把 PDF 光栅化后复用图片管线** —— 需要 poppler（GPL）或 PyMuPDF（AGPL）这类外部程序，与 MIT 插件及"零安装依赖"冲突，还丢掉了页坐标。
- **把 PDF.js 打进主包** —— 每个会话都付 6.8 MB 与解析开销，与 shell 自己的取舍相反。
- **让分块直接 import 主包的 `AnnotatorBody`** —— 会触发上面那条共享分块规则；改为由主包通过注入把组件传进分块。

## Consequences

- 只有真正打开 PDF 才付 6.8 MB 的下载与解析成本，其余会话零成本。
- 与 shell 使用同一版 PDF.js（6.3.289），因此继承它对浏览器的要求（用到 `Map.prototype.getOrInsertComputed`）。这不是新增的兼容面：内置的只读 PDF 预览有同样要求，应用内的 Electron 44 / Chromium 142+ 满足。
- 标注 N 页会得到 N 份 JSON 与 N 张 PNG，而不是一份合并文档；换来的是坐标不会错位、撤销不会跨页串台。若以后要把多页并成"一份 PDF 批注"，需要另立一条决策。
- 主包多了一个 Suspense 边界与一条注入契约（`AnnotatorBody` 由主包传入分块）。
- 真浏览器验证（本机临时脚手架，不进仓）：加载真实构建产物与真实宿主路由，打开一份 3 页 PDF → 第 1 页由 PDF.js 渲染为 1952×1562 位图（页面单位 1125×900）→ 翻到第 2 页 → 画一条箭头 → 保存 → 宿主写出 `verify.pdf.p1.annot.json`（page 1 / pageCount 3，坐标为页面单位）与 317 KB 的标注 PNG，控制台无报错。
