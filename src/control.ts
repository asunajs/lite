/**
 * 控制流。
 *
 * 条件与列表若交给"运行时 diff 一棵树"就得引入虚拟 DOM；交给编译期生成"只在必要的那个
 * 位置重建"才符合本运行时"指哪儿改哪儿"的路子。
 *
 * 两者都用**父节点 + 锚点**而非"片段对象"：少一层抽象就少一堆记账代码，且**不产生任何
 * 包装节点**（CSS 选择器不受影响）。
 */

import { createNodes, insert, own, remove, type Nodes } from './dom'
import { newEffect, ownedEffects, type Effect } from './signal'

/**
 * 列表渲染。编译期把 `list.map((x) => <Row/>)` 折成这里（Solid 用 `<For>` 组件，这里因为
 * 源码写的就是 `.map` + `key=`，做成编译期原语）。
 *
 * 锚点语义同 Solid 的 `insert`：**内容插在 `anchor` 之前**，`anchor === null` 即追加到末尾
 * —— 列表放在元素中间也不会挤坏后面的静态兄弟，**不需要注释锚点**。
 *
 * ⚠ 迭代必须**倒序**，"已就位"的判据是**组尾的下一个兄弟正好是 cursor**：正序 +
 * `nodes[0] === cursor` 看着对，实际每次更新把整列表 `insertBefore` 搬一遍（实测同序重排
 * 2000 行要 10ms，本该零次 DOM 操作）；倒序后降到 1.1ms。
 *
 * ⚠⚠ 但**新建**的行必须**正序**插进去：`<select>` 没有独立选中状态，选项插进"还没有任何
 * 选中项"的下拉框时浏览器会自动选中**第一个**被插入的（Chrome 实测：`append(b);
 * insertBefore(a,b)` ⇒ `value === 'b'`）⇒ 倒着插等于默认选**最后一项**，而 Vapor 整批
 * 正序插选**第一项**。所以倒序走，但把连续新建的行攒成一段，到边界再**正序**整段插入。
 */
export function createFor<T>(
  parent: Node,
  list: () => T[],
  render: (item: T, index: number) => unknown,
  key?: (item: T, index: number) => unknown,
  anchor: Node | null = null,
  /**
   * 这一行的内容**读到了索引参数** ⇒ 位置就是内容的一部分（`第 {i+1} 步`、
   * `disabled={i === 0}`）。由编译器判定并传进来；取舍见下面 `row.i !== i` 那段。
   */
  positional = false,
): void {
  /** key → 行。跨轮复用同一个 Map/Set，别每轮重建（那是 O(n) 的分配）。 */
  const rows = new Map<unknown, { item: T; i: number; nodes: Nodes }>()
  const seen = new Set<unknown>()

  const eff = newEffect(() => {
    // ⚠⚠ 同 `setNodes` 的自毁判据：列表整体被外部替换掉之后每行都脱开了 ⇒ 这条 effect
    // 该退休，否则它会把整张表**再插一遍**（症状：越刷新内容越多）。
    if (rows.size) {
      let alive = false
      for (const row of rows.values()) for (const n of row.nodes) if (n.parentNode) { alive = true; break }
      if (!alive) {
        eff?.dispose()
        return
      }
    }
    const items = list()
    seen.clear()
    let cursor: Node | null = anchor
    /** 连续新建的一段（倒序攒着），`runAnchor` 是这一段**后面**那个节点。 */
    let run: Nodes[] = []
    let runAnchor: Node | null = null
    const flush = () => {
      // 倒序攒的，就倒着取出来 ⇒ 实际插入顺序是**正序**（见上面那段注释）
      for (let j = run.length - 1; j >= 0; j--) insert(parent, run[j], runAnchor)
      run = []
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      const k = key ? key(item, i) : i
      let row = rows.get(k)
      /**
       * ⚠ **位置变了要不要重建，取决于这一行的内容读没读索引**（`positional`）。
       *
       * - 读了：`i` 是**普通数字**、烧进这一行的绑定闭包；复用则 DOM 顺序对了、**步号与
       *   禁用态却留在旧位置** ⇒ 必须重建。
       * - 没读：位置不进内容 ⇒ 复用。复用在意的不是字节数，是**行内的真实状态**：输入框
       *   光标与焦点、滚动位置、跑到一半的 CSS 过渡；全重建会悄悄抹掉（`demo/main.tsx`
       *   有断言钉着："重排是搬动而不是重建"）。
       *
       * 不做成"响应式的 index"（Solid 的 `index()`）：要把每个 `.map` 的第二个参数换成函数、
       * 改动面覆盖所有使用点；而判据编译期就能算准，于是用标志位换 0 行 API 变更。
       * 见 `docs/pitfalls.md`「列表复用：key、positional、块体 map」。
       */
      if (row && (row.item !== item || (positional && row.i !== i))) {
        // 同一个 key 但内容/位置换了 ⇒ 重建这一行
        remove(row.nodes)
        row = undefined
      }
      // ⚠ `fresh` 不能省：新建的行**还没进 DOM**，而"不在文档里"的节点 `nextSibling`
      // 也是 `null`，与"已经是最后一个孩子"无法区分。少了它，第一行会被判为"已就位"
      // 而不插入，第二行再插到它前面就抛 `NotFoundError: … is not a child of this node`。
      let fresh = false
      if (!row) {
        /**
         * ⚠⚠ 行内 effect 必须**挂到这一行的节点下**：编译器把 `key=` 列表里的动态绑定编成
         * **行内**的 `effect(...)`（产物形如 `createFor(…, (t) => { effect(() => setProp(btn,
         * "disabled", running.value)); … })`），它们建在**渲染回调里** —— 组件作用域与 `owners`
         * 都覆盖不到 ⇒ `remove(row.nodes)` 只摘 DOM、不销毁它们（归属机制见 `signal.ts` 的
         * `scope`）。挂到 `nodes[0]` 下即落进现有机制：`remove(row.nodes)` →
         * `disposeTree(nodes[0])` → 这批 effect 一起销毁。
         */
        const effs: Effect[] = []
        const nodes = createNodes(ownedEffects((e) => effs.push(e), () => render(item, i)))
        const first = nodes[0]
        if (first) for (const e of effs) own(first, e)
        // 空行（渲染成 null）：没有可挂的节点，直接销毁 —— 留着就是永久泄漏
        else for (const e of effs) e.dispose()
        row = { item, i, nodes }
        rows.set(k, row)
        fresh = true
      }
      seen.add(k)
      if (fresh) {
        if (!run.length) runAnchor = cursor
        run.push(row.nodes)
      } else {
        if (run.length) flush()
        const last = row.nodes[row.nodes.length - 1]
        if (!last || last.nextSibling !== cursor) insert(parent, row.nodes, cursor)
      }
      cursor = row.nodes[0] ?? cursor
    }
    if (run.length) flush()
    if (rows.size !== seen.size) {
      for (const [k, row] of rows) {
        if (!seen.has(k)) {
          remove(row.nodes)
          rows.delete(k)
        }
      }
    }
  })
  // 归属登记：列表的父节点被移除时，这个 effect 与它建的每一行一起销毁
  own(parent, eff)
}
