# Note: HTML 文档的标注能力

Status: implemented

> 前置：[2026-09-28-office-and-text-annotation.md](../../proposed/2026-09-28-office-and-text-annotation.md) 把 HTML 列为三期候选（"各自单独出 note"）；本条是它自己那份 note。
> 调研对象：`github.com/philmingdao/anno` 的 `adapters/dsh-native`（本地审阅工作台，DSH 原生插件）。

## Problem

本插件在**像素面**上标注：图片、SVG、PDF（整份一份标注），Markdown 走"编辑+差异"。`html`/`htm` 一直由 DSH 内置 HTML 预览只读打开，标注能力在这类文档上是空的——而"生成一份 HTML 报告/幻灯片让用户圈问题"是常见工作流。

难点不在"再画一个画布"，而在三件事：

1. **HTML 没有可栅格化的面。** 图片/SVG/PDF 都能导出一张"标注图"（`composeReviewSvg` → `rasterizePng`），浏览器却没有 DOM→图片的接口；iframe 也截不了。所以"标注图"这条产物对 HTML 不存在（证据 A）。
2. **要锚到元素就必须能读 DOM，而内置 HTML 预览是故意不让读的。** 内置实现把文档放进 `sandbox="allow-scripts"` 的**不透明源**框架（静态模式更狠：DOMPurify + `default-src 'none'` + `sandbox=""`），父页拿不到 `contentDocument`（证据 B、C）。想锚定就得先把这层隔离设计清楚。
3. **文档会 reflow。** 同一个元素在不同宽度下位置不同，纯像素坐标在 HTML 上没有"原尺寸"可依附。

不解决，HTML 只能继续只读；解决了，就得到"用户在报告里圈住那一段、写一句话，智能体按元素选择器去改源文件"这条链路。

## Decision

**给 HTML 一条自己的路：在固定宽度、禁脚本的同源框架里渲染，标注画在同一张覆盖层上，每条标注额外记下它落在哪个元素上。**

- **接管**：`documentPreviews` 注册 `html/htm`，`priority: 'extension'`（压过内置的 `'builtin'`），`loading: 'bytes-complete'`；查看器下拉里仍可切回内置预览，与图片/PDF 的相处方式一致（证据 D）。
- **渲染（`src/client/html-dom.ts`）**：`buildRenderedDocument()` 把文档写进框架前做两件事——在 `head` **最前面**注入 `default-src 'none'` 的 CSP（`style-src 'unsafe-inline'` 让文档自己的样式照画），并**剔除 `<base>` 与会刷新的 `<meta>`**（前者会搬走文档里所有相对引用，后者会把框架换成插件读不到的页面）。`loadFrameDocument()` 用 `document.open/write/close` 把文本写进框架（不是 `srcdoc`：jsdom 不实现它，测试会变成测空气）。
- **框架姿态**：`sandbox="allow-same-origin"`，**不给 `allow-scripts`**。同源是锚定的前提（父页要读 `contentDocument`）；禁脚本是安全的来源（脚本、内联事件处理、`javascript:` 全部由沙箱保证不执行，所以这里不需要自研 sanitizer）。CSP 再兜住对外的一切请求与嵌套框架。已写进 AGENTS.md §2.10 作为红线。
- **坐标空间**：固定 `RENDER_WIDTH = 1024` 渲染，再按面板宽度缩放（与 PDF 页同一套 `scale`/`zoom` 机制）。框架高度取它自己内容的 `scrollHeight`，因此框架内部**从不滚动**——于是元素自己的布局像素就是 mark 的坐标单位，`Canvas` 的重叠层与框架内容严格对齐，唯一的指针事件入口是覆盖层（`pointer-events:none` 挂在框架上）。
- **元素锚定（`anchorInDocument`）**：不走 `elementFromPoint`（不可靠，且 jsdom 没有），而是遍历候选元素、取**包含该点且面积最小**的盒子（同面积取更深的）；**匿名行内包装元素不计为名字**（点在标题里的 `<b>` 上，名字是那个标题），只有"该点仅被包装元素覆盖"时才退回用它。产出 `MarkAnchor` 的**加性**新字段：`selector`（从 `body` 起，每段 `tag:nth-of-type(n)`，遇到 `#id` 就截断），以及既有的 `tag`/`id`/`text`/`bbox`。
- **交付**：保存只写 `<名>.html.annot.json`（**没有** review 产物，`writeAnnotation()` 的 `review` 留空），消息用 `【HTML 标注】` 抬头、说明"渲染面"尺寸与文件哈希，结尾纪律改成"改生成这份 HTML 的源、定位以 `anchor.selector` 为准、坐标只作辅助"。零落盘之外的任何新写入面。
- **文案与纪律**：`htmlTitle`/`htmlLoading`/`htmlFrame`/`htmlStale` 四个键；系统提示段加第 7、8 条，讲清"没有标注图""按选择器定位""改源不改渲染结果"。

模型改动全部是**加性**的，不升 `version`（沿用 office/md 那条 note 的推理：升版本会砍掉与 Sati 的互通）：`MarkAnchor.selector?` 一个新可选字段，`FIGURE_EXTENSIONS` 加 `html`/`htm`，`figureMediaType` 加 `text/html`。Host 的 `readAnchor()` 负责把它带过边界（并按既有纪律截到 400 字符）。

## Alternatives considered

- **直接装 `@philmingdao/anno-dsh-native` 并存（零改动）**：能用，但是另一个插件——宿主侧 profile 行、自己的 localhost 审阅服务器与 `~/.anno` 会话存储、6 个 `html_review_*` 工具、把产物写成文档旁的 `x-reviewed.html`（第三个写入面）。它做的也不是"在侧栏标注"，而是"另开一个页面做 HTML 审阅+原位编辑"。落选：它不是本插件的能力，两套"批注→会话"语义并存对用户是负担。（它的宿主 API 在 0.2.1-alpha.1 上仍存在，但官方只声明 `<0.2.0`，装上去属于未验证。）
- **搬 anno 的编辑器进来**：`assets/editor.html` 是 70.9 KB 的 vanilla 单文件编辑器 + 自有 CSS。落选三理由：① 客户端半边是单文件 CJS、插件路由发不了静态资产，这份 UI 只能变成打进主包的字符串常量；② 它是"自己的服务器 + 同源框架"架构，搬进来等于把 UI 全部重写；③ 每文件四项 100% 且不排除任何 `src` 文件，vendored 的 70 KB 无类型代码没有出路。
- **`sandbox="allow-scripts"`（不透明源）+ 往文档里注入一份标注脚本、用 postMessage 通信**（保隔离、更像 anno）：落选。要在沙箱里重写一套 UI，构建期得把脚本源码当字符串打包进主包（新增第三种构建产物），测试与覆盖率成本都远高于收益；且注入的脚本与文档自己的脚本同处一个源，协议可被文档伪造。
- **非沙箱框架（`srcDoc`/blob 源）+ 自己写 sanitizer**：落选。那等于把任意 HTML 提升到应用源执行（能摸到 `window.parent`、`__ModuleLoader__`、会话数据），而且"完全正确的 sanitizer"是长期负债。沙箱禁脚本是浏览器给的保证，比自研剥离属性可靠。
- **只画几何、不锚元素（保住内置那层隔离）**：落选。没有元素锚定、又没有标注图，消息里只剩"在 (x,y) 处画了个框"，对智能体几乎无用。
- **为 HTML 也做一张标注图**：落选。浏览器没有 DOM→图片的能力；用 SVG `foreignObject` 绕路要内联全部字体与资源、保真度不可控，不值得作为承诺。
- **也让 HTML 走"编辑+差异"（像 md）**：落选（本期）。HTML 的 diff 噪声大、元素级评论比文本 diff 更贴合"这个标号指错了"的返工语言；两者可以以后叠加（编辑这一层是加性的）。

## Consequences

换来的：HTML 进了同一条"打开 → 画 → 保存 → 送会话"链路，侧车格式、路由守卫、投递纪律、覆盖率门禁都不另起一套；标注带**元素选择器**，智能体可以直接在源文件里命中元素，不必靠坐标猜。

付出的与要认的：

1. **渲染保真度低于浏览器**：脚本不执行、相对引用的图片与外部样式不加载（内置交互模式至少会打包 `script[src]`/`link[rel=stylesheet]`），链接点击与表单也被框架挡住。这与"给返工意见"的用途相符，但脚本渲染出来的内容在预览里是空的——已写进 README 限制与 AGENTS.md §7.6。
2. **固定 1024px 渲染**：文档里的媒体查询按 1024 生效，窄屏样式不会被看到。换来的是"坐标在任意面板宽度下同一含义"。
3. **没有标注图**：模型拿不到"用户圈的图"，只能读 `selector`/文本/坐标。这是本类型与其它类型的最大体验差异，README 限制里说清了。
4. **只做"画标注"**：anno 的"点元素写评论""原位改文字""区域记录被框住的元素清单"都没做（AGENTS.md §7.7）。
5. **`selector` 会随源文档结构漂移**：`nth-of-type` 路径在文档被重排后会指向别的元素；`sha256` 变化时的旧提示（`htmlStale`）与 `anchor.text` 引文是仅有的兜底。截到 400 字符的极端深文档会丢掉路径前缀（后缀仍精确）。

## 验收

- 三个门禁（typecheck / lint / 每文件四项 100%）全绿；`pnpm run build` 过第四条分块门禁（本次不新增分块）。
- 新增/改写的规格：`tests/html-dom.spec.ts`（渲染文档、加载框架、元素锚定与选择器），`tests/annotator-body.spec.tsx` 的「a rendered document」一组（框架姿态与 CSP 落地、按 `scrollHeight` 量高、量不到高度时拒绝保存、画标注取到的锚点、保存只写标注文件、交付无图片附件、`htmlStale`/`htmlLoading` 文案），`tests/session.spec.ts`（HTML 抬头与结尾纪律，中英各一），`tests/annotation.spec.ts`（`selector` 过边界并被截断、`describeMark` 渲染选择器），`tests/address.spec.ts`（后缀与媒体类型），`tests/plugin-client.spec.tsx`（第四个渲染器与它的注入面）。
- **真机验证**（隔离实例：真实 `lib/` 产物 + 真实宿主 + 真实浏览器，`DSH_HOME` 在临时目录，验证完即删）：
  1. **渲染与隔离**：在侧栏打开一份 HTML，`HTML 标注` 接管预览，正文渲染在 `sandbox="allow-same-origin"`、`width:1024px`、高度按内容量出（224px / 165px / 203px 三次都随文档走）的框架里；框架文档里有注入的 CSP；父页读得到 `contentDocument`。
  2. **禁脚本**：把带 `<script>document.title='SCRIPT-RAN'</script>` 与内联 `onclick` 的文档放进预览，框架里 `script` 元素在、但标题与文本**没有被改写**，脚本没跑。
  3. **画标注 → 锚点**：在渲染面上真实拖拽，标注清单出现「锚定: ← 被指元素的文字」；保存后侧车里的 `anchor` 是 `{tag, bbox, text, selector}`，`figure` 是 `{mediaType:'text/html', width:1024, height:<量出的高度>}`，且**没有** review 产物（文件只有 `report.html.annot.json`）。
  4. **交付**：点「保存并提交给智能体」，会话里出现 `【HTML 标注】<路径>（渲染面 1024×224，标注 1 处，文件 sha256:…）` + 逐条标注 + 纪律结尾；**智能体照着改了源文件**（删掉了被标注的那一段，`report.html` 从 695 B 变 621 B），整条"标注 → 改源"闭环在真机跑通。
  5. **回归**：同一实例里 SVG 预览照常工作（`附图标注` 渲染 + 拖拽 + 锚定），HTML 的出现没有动到其它类型。
- 真机验证抓到一个单测看不见的缺陷并已修：`selector` 原本是"从 body 起"但**没有写出根**（`p:nth-of-type(1)`），智能体在真机里当场指出它会把嵌套的 `<p>` 认成第一个——现在路径要么以 `body > ` 开头、要么以 `#id` 自称根，可以原样粘进 `querySelector`。这条是"真浏览器走交互"这条纪律的价值所在，记在这里以免下次又被省掉。
