# Note: 标注正文：scrollport 只交付一次

Status: implemented

## Problem

`AnnotatorBody` 把 `.da-stage` 交给宿主时用的是行内箭头 `ref={(element) => { stageRef.current = element; props.scrollportRef?.(element) }}`。React 在 ref 回调**身份变化**时会先以 `null`、再以元素调用它，而行内箭头每次渲染都是新身份——于是正文每渲染一次就交付一次。规格里一段很小的交互序列（切到标注态、选画笔）实测交付 5 次。

宿主对这次交付不是无副作用的。`ui-sidebar-documentpreview` 的 `TextPreview`：

```ts
const bindScrollport = useCallback((scrollport: HTMLElement | null): void => {
  const next = scrollport ?? bodyRef.current
  scrollportRef.current = next
  if (next !== null) next.scrollTop = storedScrollTopRef.current
}, [])
```

**每交付一次，就把这个标签页记住的滚动位置写回被交付的元素**；传 `null` 时写的是宿主自己的 `.body`（`overflow:auto`）。也就是说，读者把页面滚到某处之后，任何一次重渲染（输入说明、落一条标注、宿主为自身原因渲染）都会把那个位置再写回去一次。

## Decision

`attachStage` 用 `useCallback(..., [props.scrollportRef])` 定义、`ref={attachStage}`：只有宿主换掉回调、或正文卸载时才重新交付。挂载时仍交付一次（宿主的恢复语义就建立在那一次上），卸载时收到 `null`。

## Alternatives considered

- **保持行内箭头（现状）** —— 只有在「写回的值 ≠ 读者当前位置」时才看得见。当前 `TextPreview` 的 store 是 `defineStore` 默认的 `flush:'sync'`（`@deepseek-ai/dsh-client-store` 只在 `flush:'raf'` 时把通知推迟到下一帧），写回的值通常就是刚存下的那个，所以重复交付**目前**多为空写。但 `createSnapshotStore` 的注释自己写明 raf 模式下「订阅者下一帧才听到」：任何 raf 刷新的消费者、任何延迟一拍的存储，都会让写回变成把页面拉回旧位置——也就是标注时页面在指针下跳。这次把「只有当位置是我自己刚写过的，写回才安全」这条不对称的隐含假设去掉。
- **不在插件侧交付，让宿主自己找滚动容器** —— 宿主等的就是这个回调；不交付等于放弃「回到读者上次的位置」，而宿主的 `.body` 在我们这种自己撑满的渲染器下并不滚动，正文自己的滚动区才是唯一的滚动容器。
- **插件自己记住并恢复滚动位置** —— 与宿主的每标签页记忆重复，标签切换时会出现两份真值。

## Consequences

- 交付次数：那段小交互序列从 5 次降到 1 次（规格 `hands the owner the scrollport once, and takes it back when the body goes` 用「引入回归 → 变红 → 回退」验证过：换回行内箭头时该断言变红，报 `expected […(5)] to have a length of 1`）。
- 真实浏览器里同一件事：窄侧栏（384px 窗格）标注态静置 5 秒只交付 1 次（`["da-stage"]`）；翻一页是 `["da-stage", null, "da-stage"]`——卸载一次、新页的正文挂载一次，正是期望的「每个挂载一次」，而不是「每次渲染一次」。
- 除挂载那一次外，正文的滚动位置不再被任何渲染写回。
- 与 `2026-09-28-pdf-pane-repaint-and-light-palette.md`、`2026-09-28-pdf-page-turn-commit.md` 同批：那两条处理「PDF 窗格重绘」，这条处理「交付 scrollport 的次数」，共同点是「重渲染不该有可见副作用」。
