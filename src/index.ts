/**
 * lite —— 轻量 TSX 前端框架：**无虚拟 DOM + 编译期绑定**，与 Vue Vapor 同路。
 *
 * 语法子集**刻意窄**，不含"以后可能用得上"的东西：**没有** computed / reactive /
 * provide-inject / nextTick / Teleport / Transition / Suspense / 异步组件 / 指令。
 * 唯一保留的 Vue 旧名是 `ref` / `.value`（读起来就是"一个可写的格子"，见 `signal.ts`）。
 *
 * 下面三组导出**别当成同一回事**：
 * - 第一组由**编译器**写进产物（名单 = `compiler.ts` 里所有 `this.h('…')`），改名即断产物；
 * - 第二组是**业务代码**手写的（组件、生命周期、挂载、插槽）；
 * - 第三组是运行时内部件（`createFor` / `setNodes` 的实现细节），demo 与排障会直接调。
 */

// ── 编译器 import 的那批 ────────────────────────────────────────────────────
export { batch, effect, ref, type Ref, watch } from './signal'
export { createComponent } from './component'
export { createFor } from './control'
export { lazySlot, on, remove, setAttr, setClass, setNodes, setProp, setValue, spread, template } from './dom'

// ── 业务代码会手写到的那批 ─────────────────────────────────────────────────
export { type Component, mount, onMounted, onUnmounted, type Slots, useSlots } from './component'

// ── 运行时自己的内部件（demo / bench / 排障会直接调，业务代码不该用）────────
// `insert` / `createNodes` 是 `createFor` 与 `setNodes` 的实现细节。
// 纯文本快路确实存在，但在 `setNodes` 内部，不是这里的导出。
export { createNodes, insert, onRemove } from './dom'
