/**
 * DOM 层。核心思路：**编译期把静态结构变成一行 HTML 字符串，运行期只做动态那几下**。
 *
 * * 静态结构 → `template()` 在**模块加载时**解析一次，之后每个实例只 `cloneNode`。
 * * 动态文本/属性 → 编译期生成 `effect(() => ...)`，只写那一个节点、那一个属性。
 * * 事件 → 事件名编译期已知，运行期就是一次 `addEventListener`，没有包装层。
 *
 * **没有虚拟 DOM**：整棵树自始至终都是真实节点，更新"指哪儿改哪儿"，没有 diff 与 vnode。
 * 节点路径也由编译期算好（`el.firstChild.nextSibling` 直接写进源码），运行时不带
 * "按标记找插槽"的遍历 —— 这是省字节的大头（Solid 用 `<!--$-->` 注释锚点，这里连它都省了）。
 */

import { DEV } from './dev'
import { type Effect, newEffect, ownedEffects } from './signal'

/** 渲染结果统一成节点数组：**不引入任何包装元素**，所以 CSS 选择器与布局与原来逐像素一致。 */
export type Nodes = Node[]

export function createNodes(v: unknown): Nodes {
  if (v == null || v === true || v === false) return []
  // 数组里可能夹着 null/false（片段成员的 `cond ? x : null`），先滤掉再铺
  if (Array.isArray(v)) return v.flat(9).filter(Boolean) as Nodes
  return [v instanceof Node ? v : document.createTextNode(String(v))]
}

/**
 * 把一个静态 HTML 串变成"克隆工厂"：编译期生成、模块级只调用一次。
 * `cloneNode(true)` 比 `innerHTML` 快一个量级，且不用每次重新解析。
 */
export function template(html: string): () => Node {
  const box = document.createElement('template')
  box.innerHTML = html
  const content = box.content.firstChild as Node
  return () => content.cloneNode(true) as Node
}

/**
 * 谁拥有哪个 effect：`parent` 被移除时，它名下的 effect 全部销毁。
 *
 * ⚠⚠ 这条记账是**必需**的，不是优化：少了它，被移除子树里的 effect 仍订阅着全局信号，
 * 信号一变就拿着**已不在文档里**的 `parent`/`anchor` 去 `insertBefore`，直接抛
 * `… is not a child of this node`。见 `docs/pitfalls.md`「effect 的归属：什么时候必须销毁」。
 *
 * ⚠⚠ 必须是 `WeakMap` 而不是 `Map`：`setNodes` 会把 effect 登记到**已脱离文档**的父节点上
 * （异步数据回来时视图早被换掉）⇒ 父节点成了键，`Map` 强引用整棵子树。`WeakMap` 的
 * ephemeron 规则让"值反过来引用键"不阻碍回收，且这里只做按键的 get/set/delete/has。
 */
const owners = new WeakMap<Node, Effect[]>()

function own(parent: Node, eff: Effect): void {
  const list = owners.get(parent)
  if (!list) {
    owners.set(parent, [eff])
    return
  }
  /**
   * ⚠⚠ 顺手把**已销毁**的 effect 清出去：长命的父节点每挂一次新内容就攒一条死 effect，
   * 而死 effect 的闭包仍攥着它当年铺进 DOM 的那批节点（`setNodes` 的 `cur`）⇒ 子树早脱离
   * 文档也一直被拽着。
   */
  const alive = list.filter((e) => !e.disposed)
  alive.push(eff)
  owners.set(parent, alive)
}

/** 销毁一棵（已被移除的）子树里登记过的所有 effect **与卸载钩子**。 */
function disposeTree(node: Node): void {
  // 子树里嵌着的碎片槽也要收（切页 / 条件分支整块移除时）
  if (slots.has(node)) removeSlot(node)
  const list = owners.get(node)
  if (list) {
    owners.delete(node)
    for (const eff of list) eff.dispose()
  }
  /**
   * ⚠⚠ 卸载钩子也必须**按整棵子树**收：只在 `remove(nodes)` 里取 `nodes[0]` 那把 key
   * 跑钩子的话，父级摘整棵子树时**子组件登记的 `onUnmounted` 永远不跑** ⇒ `clearInterval`
   * / 关流收尾全部落空。递归顺序**父先子后**，与 effect 的销毁顺序一致。
   */
  const unmounts = cleanups.get(node)
  if (unmounts) {
    cleanups.delete(node)
    for (const cb of unmounts) cb()
  }
  /**
   * ⚠⚠ 递归前**先把孩子快照下来**：`node.childNodes` 是**活的** NodeList，而这一轮会跑
   * `onUnmounted` 钩子、钩子**会改 DOM**；边遍历边被改的活列表会**跳过**节点 ⇒ 被跳过的
   * 子树既不销毁 effect 也不跑钩子（症状是"只有某一棵子树漏"，极难查）。
   */
  const kids = Array.from(node.childNodes)
  for (const child of kids) disposeTree(child)
}

/** 批量插入。`anchor` 为 null 即追加到末尾。
 *
 * ⚠⚠ 锚点**可能已经不在 `parent` 里了**，不能直接 `insertBefore`：那会抛
 * `… is not a child of this node`，而后果不止顺序不对 —— **整次更新被打断**，后面的
 * `flushSlots` / `flushMounted` 全不跑，页面停在半更新状态。机理见 `docs/pitfalls.md`
 * 「锚点：动态子节点为什么会错位」。
 *
 * 锚点脱开多半是第三方动了那棵 DOM（浏览器扩展 / 用户脚本），干净 profile 里复现不出来。
 * 处置：退化成**追加到末尾**并警告一次（带锚点与父节点信息），让更新走完。
 */
let warnedDetachedAnchor = false

/**
 * `insert` 的嵌套深度 —— **收尾工作只在最外层做一次**。
 *
 * `flushSlots()` / `flushMounted()` 都是"扫一遍待办队列"，原先挂在**每一次** `insert` 后；
 * 而 `createFor` 每挪一行调一次 `insert`，2,000 行的反转要扫 2,000 轮队列（bench 实测：
 * 反转 2000 行 ×10 = 9.9ms、追加 100 行 ×10 = 5.5ms，是运行时最慢的两项）。
 *
 * ⚠⚠ `inserting` 只包住**一次** `insert` 调用里的 `insertBefore` 循环，兄弟节点逐个调 ⇒
 * 每个兄弟仍各收尾一次。真正省下的是下面两个**空判**（队列空时连函数调用都不发生）；
 * 队列状态仍一致，晚一点跑只影响中间态，而全程同步、没人能观察到中间态。
 */
let inserting = 0

export function insert(parent: Node, nodes: Nodes, anchor: Node | null = null): void {
  let at = anchor
  if (at && at.parentNode !== parent) {
    // ⚠ 告警只在**开发构建**里编译进去（`DEV` 在 build 时折成 `false`，整块连同长文案与
    // 抓栈一起被删，实测 gzip −239 B）；退化成追加是**行为**，不受 DEV 影响。
    // ⚠ 这里**故意不带**"调用方标签"参数：折掉告警后那些字符串**照样留在产物里**，
    // 而"谁调的"由下面的 `stack` 给出，且更精确。
    if (DEV && !warnedDetachedAnchor) {
      warnedDetachedAnchor = true
      // 只警告一次：真出问题时控制台不至于被刷爆
      console.warn('[lite] 锚点已不在父节点内，本次退化为追加到末尾', {
        anchor: at.nodeType === 8 ? '<!--占位注释-->' : at.nodeType === 3 ? `#text(${JSON.stringify(at.nodeValue?.slice(0, 12))})` : at.nodeName,
        anchorParent: at.parentNode?.nodeName ?? null,
        parent,
        stack: new Error('锚点脱开').stack?.split('\n').slice(1, 6).join('\n'),
      })
    }
    at = null
  }
  inserting++
  try {
    for (const n of nodes) parent.insertBefore(n, at)
  } finally {
    inserting--
  }
  if (!inserting) {
    if (pending.length) flushSlots()
    if (mounts.length) flushMounted()
  }
}

/**
 * 挂载钩子排队：**节点进了文档**才跑（`onMounted` 语义与 Vue 对齐）。
 *
 * ⚠⚠ 不能只在"应用挂载那一刻"flush 一次：**条件分支翻转、列表插入、切页**都会在之后建出
 * 新组件，其 `onMounted` 若不跑，页面会停在"加载中"且**一声不响**（没有异常）。
 * 所以每次 `insert` 之后都试着 flush；还没进文档的（父节点自己还没被插入）留到下一轮。
 */
const mounts: { node: Node | undefined; cb: () => void }[] = []

export { own }

export function queueMount(nodes: Nodes, cb: () => void): void {
  const node = nodes[0]
  // 组件渲染成空（`null`）时没有"进文档"可言，直接跑，别让它永远排在队里
  if (!node) cb()
  else mounts.push({ node, cb })
}

let flushing = false

/** 跑掉"已经进文档"的挂载钩子。有界多轮：钩子里还会建组件（子先父后）。 */
function flushMounted(): void {
  if (flushing) return
  flushing = true
  try {
    for (let pass = 0; pass < 8 && mounts.length; pass++) {
      const list = mounts.splice(0)
      for (const m of list) {
        if (m.node?.isConnected) m.cb()
        else mounts.push(m)
      }
    }
  } finally {
    flushing = false
  }
}

/**
 * 片段（fragment）里的动态成员：**先出一个占位文本节点，等它进了文档再接管**。
 *
 * 为什么延后：`setNodes` 要知道父节点（内容插在占位之前），而片段在被消费方插入之前
 * **没有父节点**。Solid 把这种成员包成 `memo(...)`，那就得引入观察者与调度器；这里换成
 * "占位 + 插入后接管"，**同步**建绑定。
 *
 * ⚠⚠ **占位与实际内容必须绑在一起**：碎片内容由槽自己那条 effect 插在占位**后面**，父槽
 * re-run 时 `remove(cur)` 只摘掉占位、**内容原地留下** ⇒ 每刷一次多一整套（"越刷新内容
 * 越多"）。所以按占位记账 `{fn, nodes, eff}`，`remove()` 遇到占位就把 effect 与它插的
 * **所有**节点一起收掉。
 */
type Slot = { fn: () => unknown; nodes: Nodes; eff?: Effect }
/** 占位节点 → 碎片槽。⚠ 同样必须是 `WeakMap`（理由见上面的 `owners`）：占位也可能落在
 * 一条已断开的旧子树里。 */
const slots = new WeakMap<Node, Slot>()
let pending: Node[] = []

/** 收掉一个碎片槽：停 effect + 移除它插进去的内容（递归，碎片里可能还嵌槽）。 */
function removeSlot(ph: Node): void {
  const s = slots.get(ph)
  if (!s) return
  slots.delete(ph)
  s.eff?.dispose()
  remove(s.nodes)
}

export function lazySlot(fn: () => unknown): Node {
  const ph = document.createTextNode('')
  slots.set(ph, { fn, nodes: [] })
  pending.push(ph)
  return ph
}

/**
 * 接管"已经进文档"的槽；还没进文档的（父片段也还没被插入）留给下一轮。
 *
 * ⚠ 必须**有界多轮**而不是递归调用自己：槽里可能还有槽（片段套片段），但嵌深有限；递归版
 * （在 `insert` 里直接再 flush）曾出现**重复插入** —— 同一个视图被追加上千次、`#app` 涨到
 * 102 KB，Chrome 虚拟时间因此走不完（回归脚本卡死）。
 */
function flushSlots(): void {
  for (let pass = 0; pass < 8 && pending.length; pass++) {
    const list = pending
    pending = []
    for (const ph of list) {
      const slot = slots.get(ph)
      if (!slot) continue // 槽已被收掉（父槽重渲染过），别再插一份
      const parent = ph.parentNode
      if (parent) setNodes(parent, slot.fn, ph, slot)
      else pending.push(ph)
    }
  }
}

/**
 * 卸载登记的清理函数。键用**节点数组的第一个节点**：组件卸载时它的节点整体被撤掉，用首
 * 节点就能找回 `onUnmounted` 钩子。用 `WeakMap` 而不是在节点上挂属性，不给 DOM 留痕迹。
 *
 * ⚠⚠ 必须是 `WeakMap`：`Map` 强引用键 ⇒ 只要有一条登记没被 `delete`，那个节点连同**整棵
 * 子树与它上面的监听器**就永远活着（症状：切页若干来回后监听器与节点计数一路涨）。
 */
const cleanups = new WeakMap<Node, (() => void)[]>()

export function onRemove(nodes: Nodes, cb: () => void): void {
  const key = nodes[0]
  if (!key) {
    cb()
    return
  }
  const arr = cleanups.get(key)
  if (arr) arr.push(cb)
  else cleanups.set(key, [cb])
}

/**
 * 撤掉一批节点。**所有移除都要走这里** —— 它顺带把组件的卸载钩子跑了
 * （`onUnmounted` 里多半是 `removeEventListener`，漏跑就是内存泄漏）。
 */
export function remove(nodes: Nodes): void {
  // ⚠ 先收碎片槽：否则碎片内容成孤儿留下（症状：越刷新内容越多）
  for (const n of nodes) removeSlot(n)
  // 先销毁这棵子树里的 effect **与卸载钩子**，再摘节点：销毁只解绑订阅，不动 DOM。
  // ⚠ 钩子收尾归 `disposeTree` 管（它按整棵子树走）—— 这里**不要再单独跑一遍**
  //   `nodes[0]` 那把 key，否则同一条 `onUnmounted` 会执行两次（关两次流）。
  for (const n of nodes) disposeTree(n)
  for (const n of nodes) n.parentNode?.removeChild(n)
}

/**
 * 响应式子节点（Vapor 里叫 `setNodes`）：JSX 里 `{expr}` 这种"一整段内容"由它接管。
 * 每次重跑先撤掉上一次铺进去的节点再铺新的 —— 内容替换的语义下这是最省字节的写法，
 * 不需要在节点间做 diff（这不是"列表"）。
 */
export function setNodes(parent: Node, fn: () => unknown, anchor: Node | null = null, track?: Slot): void {
  let cur: Nodes = []
  const eff = newEffect(() => {
    /**
     * ⚠⚠ **陈旧 effect 自毁**：那块内容被别处整块替换掉后（切页 / 重建），`cur` 已全部
     * 脱离文档、`remove(cur)` 变成空操作，而这条 effect 还活着 ⇒ 每次数据变化都**追加
     * 新的一份**、无限增长（症状："越刷新内容越多"）。父节点还活着，所以"按父节点记账"
     * 的销毁机制管不到它。判据：上次插的节点**全都**不在文档里 ⇒ 退休；必须放在做任何
     * 事之前（尤其不能先 remove/insert）。
     */
    if (cur.length && cur.every((n) => !n.parentNode)) {
      eff?.dispose()
      return
    }
    /**
     * ⚠⚠ `fn()` 里建的 effect 也必须有归属（机制见 `signal.ts` 的 `scope`）：这里是
     * `newEffect()` 的求值上下文，`scope` 为空 ⇒ 那些 effect **谁都不管**，`remove(cur)`
     * 只摘 DOM、不销毁它们。典型触发是用 `setNodes(parent, () => items.map(…))` 铺列表
     * （而非 `createFor`）⇒ 每切一次页就重建一遍、旧的永不销毁，而它们读的正是长命信号。
     */
    const effs: Effect[] = []
    const v = ownedEffects((e) => effs.push(e), fn)
    /**
     * 文本快路径（Solid 的 `insertExpression` 同款）：值仍是字符串、且位置上就是上次
     * 放的那个文本节点时，直接改 `.data`，不删不建。文本更新是最高频的绑定，这里省下
     * 的是真实的 DOM 操作。
     */
    if (typeof v === 'string' || typeof v === 'number') {
      // 文本值建不出 effect（`fn()` 返回的就是字符串）。真有也只能销毁 ——
      // 没有节点可挂，留着就是永久泄漏。
      for (const e of effs) e.dispose()
      const only = cur[0]
      if (cur.length === 1 && only && only.nodeType === 3) {
        const t = String(v)
        if ((only as Text).data !== t) (only as Text).data = t
        return
      }
      const t = document.createTextNode(String(v))
      remove(cur)
      cur = [t]
      // ⚠⚠ 必须走 `insert()`：裸 `parent.insertBefore(t, anchor)` **绕过锚点护栏**，锚点
      // 脱开时同样抛 `… is not a child of this node`（文本槽最容易脱开）。统一走 insert，
      // 顺带带上 flushSlots/flushMounted。
      insert(parent, cur, anchor)
      return
    }
    remove(cur)
    cur = createNodes(v)
    insert(parent, cur, anchor)
    /**
     * 归属：把这一段里建的 effect 挂到**新铺进去的节点**下，下次重跑的 `remove(cur)`
     * （→ `disposeTree`）会把它们一起销毁。渲染成空（`null` / `false`）时没有可挂的
     * 节点，直接销毁（留着就是永久泄漏）。
     */
    const first = cur[0]
    if (first) for (const e of effs) own(first, e)
    else for (const e of effs) e.dispose()
    if (track) track.nodes = cur
  })
  // 归属登记：`parent` 被移除时这个 effect 一起销毁（否则它会带着死锚点继续重跑）
  if (track) track.eff = eff
  own(parent, eff)
}

/**
 * `setAttr` 里"`false` ⇒ 移除属性"的属性名白名单 —— 与 Vue 的 `isSpecialBooleanAttr` 同一份
 * （`checked`/`disabled`/`required` 这些**短路在 `setProp` 上**，不走这里）。
 */
const BOOL_ATTR = new Set(['allowfullscreen', 'formnovalidate', 'ismap', 'itemscope', 'nomodule', 'novalidate', 'readonly'])

/** 类名（Vapor 也叫 `setClass`）：HTML 元素走 `className`，比 `setAttribute` 少一次解析。 */
export function setClass(node: Node, v: unknown): void {
  const el = node as Element
  const s = v == null || v === false ? '' : String(v).trim()
  /**
   * ⚠⚠ 不能无条件写 `el.className`：**SVG 元素的 `className` 是只读的** `SVGAnimatedString`，
   * 赋值直接抛 `TypeError`（`class` 绑定常挂在图标元素上，一抛就是整个组件树建不出来）。
   * HTML 元素上 `className` 比 `setAttribute` 省一次解析，所以两路分开走。
   */
  if (typeof el.className === 'string') {
    if (el.className !== s) el.className = s
  } else if (el.getAttribute('class') !== s) {
    el.setAttribute('class', s)
  }
}

/**
 * 普通属性。`null` 移除；`false` 只有布尔属性才移除，其余一律 `String(v)`。
 *
 * ⚠ 不能把 `true` 写成 `""`：这条路径收到 `true` 的都不是布尔属性（`disabled`/`checked`
 * 那些在编译器里走 `setProp`），而是 `{...BASE}` 展开与 `aria-*` —— `aria-hidden={true}`
 * 必须序列化成 `"true"`，`""` 既不是合法 ARIA 值也和 Vue 的产物对不上。
 */
export function setAttr(node: Node, name: string, v: unknown): void {
  const el = node as Element
  // `false` 只在**布尔属性**上表示"移除"；其余要序列化成 `"false"`
  // （`spellcheck={false}`、`aria-hidden={false}` 都是这个语义）
  if (v == null || (v === false && BOOL_ATTR.has(name))) el.removeAttribute(name)
  else el.setAttribute(name, v === false ? 'false' : String(v))
}

/** DOM 属性（`checked` / `disabled` 这类"改属性比改标签更对"的）。 */
export function setProp(node: Node, name: string, v: unknown): void {
  // biome-ignore lint/suspicious/noExplicitAny: 属性名与节点类型都由编译器静态决定
  ;(node as any)[name] = v == null ? '' : v
}

/**
 * `value`（输入框 / 下拉框）。**property 与 attribute 都写** —— 与 Vapor 的 `setValue` 一致。
 *
 * ⚠ 只写 property 不够：`--dump-dom`、`outerHTML`、`getAttribute('value')` 与一切"读标签"
 * 的代码都看不到值，而 `<input value={x} readonly>` 这种**只读展示框**恰恰只靠它显示。
 */
export function setValue(node: Node, v: unknown): void {
  const el = node as HTMLInputElement
  const s = v == null ? '' : String(v)
  // `<option>` 的 `value` 是**属性**语义（没有 property 回退），Vapor 也是单独判它
  const old = el.tagName === 'OPTION' ? el.getAttribute('value') : el.value
  if (old !== s) el.value = s
  if (v == null) el.removeAttribute('value')
  else el.setAttribute('value', s)
}

/** 事件。事件名由编译器从 `onClick` 折成 `click`。 */
export function on(node: Node, name: string, fn: (e: Event) => void): void {
  node.addEventListener(name, fn)
}

/**
 * `{...obj}` 展开。编译期只在**表达式含响应式读取**时才包 effect，
 * 否则就是一次性铺属性（常见情形是给 `<svg>` 铺模块级常量对象）。
 */
export function spread(node: Node, obj: Record<string, unknown>): void {
  const el = node as Element
  for (const k in obj) {
    const v = obj[k]
    if (k[0] === 'o' && k[1] === 'n') on(el, k.slice(2).toLowerCase(), v as (e: Event) => void)
    else if (k === 'class') setClass(el, v)
    else setAttr(el, k, v)
  }
}
