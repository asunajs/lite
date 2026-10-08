/**
 * 响应式核心。设计取舍都为"小 + 够用"：
 *
 * 1. **同步 + 批量**，不做微任务调度队列：要合批就用 `batch()`，不引入 nextTick。
 * 2. **不用 Proxy**：信号是类实例、读写走访问器 —— Proxy 每次读写都过陷阱，既慢又占字节。
 * 3. **依赖记账用双向 Set**：effect 记着自己的依赖（重跑前清），信号记着自己的订阅者
 *    （变更时通知）；两边都留一份，重跑时才能精确解绑。
 * 4. **`computed` 是"急"的**（依赖一变就算，不等读）：同步模型里最省字节的实现；顺带靠
 *    `RefImpl` 的 `Object.is` 拿到"派生值没变就不通知下游"的去重。链上套链会有嵌套深度，
 *    所以循环更新的守卫同时兜住 computed 互写。
 *
 * API：`ref` / `computed` / `effect` / `batch` / `watch`。`ref` / `.value` 是唯一留下的
 * Vue 旧名 —— 读起来就是"一个可写的格子"。
 */

/** 当前正在运行的 effect。用模块级单值而不是给每个函数传参：少一层参数、少一堆字节。 */
let active: Effect | null = null

/**
 * 当前的**组件作用域**：这段时间内新建的 effect 交给它（组件卸载时统一销毁）。
 *
 * `watch` 建的 effect 不属于任何 DOM 节点，走不到 `dom.ts` 那套"按节点记账"的路子，少了
 * 这一层就会在卸载后还活着、回调读到旧实例状态且没人停它。⚠ DOM 绑定（`setNodes` /
 * `createFor`）**不走这里**（已按节点记账、粒度更细），所以内部用 `newEffect()`，
 * 公开 `effect()` 才挂作用域。
 */
let scope: ((e: Effect) => void) | null = null

/** 在 `fn` 执行期间把新建的 effect 登记给 `add`（嵌套安全：进时存、出时恢复）。 */
export function ownedEffects<T>(add: (e: Effect) => void, fn: () => T): T {
  const prev = scope
  scope = add
  try {
    return fn()
  } finally {
    scope = prev
  }
}

/** batch 深度。>0 时变更只入队，归零时统一排空（同一个 effect 一轮只跑一次）。 */
let depth = 0
const pending = new Set<Effect>()

/**
 * effect 重入的上限：`A → B → A` 这种互写在这里变成一条可读的抛错，而不是把栈打爆；
 * 正常嵌套只有一两层，100 足够。
 *
 * ⚠ 它**不指名**是哪个 effect（要指名得给每个 effect 存标签，白付字节）。比 `RangeError:
 * Maximum call stack size exceeded` 强的是**有边界、能停下**：爆栈时中途的 DOM 写入已把
 * 现场冲掉，而这条至少告诉你"是互写，不是数据太多"。
 */
let nesting = 0
const MAX_NESTING = 100

/** `dispose()` 之后 `fn` 的落点：一个共享的空函数（不额外造闭包）。 */
const EMPTY_FN = (): void => {}

export class Effect {
  /** 我依赖了哪些信号 —— 重跑前要逐个解绑，否则依赖会越滚越大。 */
  readonly deps = new Set<RefImpl<unknown>>()

  /** 已经销毁：不再跑，也不再被通知。见 `dispose()`。 */
  disposed = false

  /** 这条副作用要跑的函数。⚠ 不是 `readonly`：`dispose()` 会把它换成空函数。 */
  fn: () => void

  constructor(fn: () => void) {
    this.fn = fn
    this.run()
  }

  /**
   * 销毁：解绑所有依赖并停用。
   *
   * ⚠⚠ 不销毁不只是泄漏，还会**报错**：被移除子树（切页、条件分支、列表删行）里的 effect
   * 仍订阅着**全局**信号，信号一变就拿着**已不在文档里**的 `parent`/`anchor` 去
   * `insertBefore` ⇒ `… is not a child of this node`。节点被移除时由 `dom.ts` 的
   * `remove()` 统一销毁（它按"谁拥有节点"记账）。
   */
  dispose(): void {
    this.disposed = true
    for (const d of this.deps) d.subs.delete(this)
    this.deps.clear()
    /**
     * ⚠⚠ 必须**松开 `fn`**：它是渲染闭包，攥着铺进 DOM 的那批节点。只把 `disposed` 置真却
     * 继续持有闭包 ⇒ 那棵**已脱离文档**的子树照样活着，等于没销毁。换成共享空函数后不再跑
     * 得到（`run()` 有 `disposed` 守卫），也不多一个闭包。
     */
    this.fn = EMPTY_FN
  }

  run(): void {
    if (this.disposed) return
    if (nesting >= MAX_NESTING) {
      // ⚠ 文案刻意**短**：这是生产路径上的守卫（不像诊断那样会被 DEV 折掉），
      // 长文案是直接进产物的字节。要点保住：循环更新 + 查信号互写 + 上限值。
      throw new Error('[lite] 循环更新：effect 复入超过 ' + MAX_NESTING + ' 层，已中断（检查信号 / computed 是否互相写）')
    }
    for (const d of this.deps) d.subs.delete(this)
    this.deps.clear()

    const prev = active
    active = this
    nesting++
    try {
      this.fn()
    } finally {
      nesting--
      active = prev
    }
  }

  /** 被通知时：批量中先入队，否则立刻跑。 */
  notify(): void {
    if (depth) pending.add(this)
    else this.run()
  }
}

/**
 * 建一个 effect。**内部用**（`dom.ts` 的绑定、`control.ts` 的列表走这里）。
 * 与公开 `effect()` 的区别：不挂组件作用域 —— 这些 effect 已有更细的归属（`owners` 按
 * **节点**记账），再登记一份纯属重复记账。
 */
export function newEffect(fn: () => void): Effect {
  return new Effect(fn)
}

class RefImpl<T> {
  readonly subs = new Set<Effect>()

  constructor(private v: T) {}

  /**
   * ⚠ 必须是**访问器** `get value()`：写成普通方法 `get()`/`set()` 时 `.value` 会退化成
   * 数据属性，读写全绕过依赖记账 —— 症状是"初始渲染对、之后点什么都没反应"。
   */
  get value(): T {
    if (active) {
      // 双向记账：effect 记得我，我记得 effect
      this.subs.add(active)
      active.deps.add(this as RefImpl<unknown>)
    }
    return this.v
  }

  set value(n: T) {
    // Object.is：NaN 与 +0/-0 的边界与 Vue 一致，顺带避免"同值重设"触发无谓的 DOM 写
    if (Object.is(n, this.v)) return
    this.v = n
    // ⚠ 订阅者可能在回调里退订（例如条件分支删掉某棵子树），不能原地遍历。0 个与 1 个
    // 是绝大多数情形，为它们各分配数组是白付的 GC 压力 —— 只有两个以上才复制。
    const n0 = this.subs.size
    if (!n0) return
    if (n0 === 1) {
      const only = this.subs.values().next().value as Effect
      if (!only.disposed) only.notify()
      return
    }
    for (const e of [...this.subs]) e.notify()
  }
}

/** 只读格子：`computed` 的返回值，也是所有绑定/监听能接受的最小形状。 */
export interface ReadonlyRef<T> {
  readonly value: T
}

/** 信号。沿用 Vue 的 `ref` 名字与 `.value` 读写。 */
export interface Ref<T> extends ReadonlyRef<T> {
  value: T
}

export function ref<T>(value: T): Ref<T> {
  return new RefImpl(value) as unknown as Ref<T>
}

/**
 * 在 `fn` 里**不建立依赖**地读信号：读到的值不会让当前 effect 订阅它。
 *
 * 用在"只是想看一眼当前值，但不想因为它变了就重跑"的地方 —— 例如 effect 里读一份配置、
 * 读当前选中项做判断。没有它，这类读会让 effect 的依赖越滚越大（症状是"改了个无关的状态，
 * 这块也跟着重跑"）。
 */
export function untrack<T>(fn: () => T): T {
  const prev = active
  active = null
  try {
    return fn()
  } finally {
    active = prev
  }
}

/**
 * 派生值：**带缓存**的只读格子，`fn` 依赖变了才重算，读多少次都只算一次。
 *
 * ⚠ 它是**急**的（依赖一变就算，哪怕没人读）—— 同步模型里最省字节的实现；代价是"没人读的
 * computed 也在算"。真在意那点算力，就别建它，把表达式写进 JSX（编译器本来就按位订阅）。
 *
 * ⚠ 返回值**只读**（类型层面；运行期写它会在下次依赖变化时被覆盖）：派生值再被写，
 * 依赖图就没有唯一真相了。
 *
 * ⚠⚠ 它自己**不会**成环（只读 + 没有写就没有环）：会出事的是"computed / 信号 / effect"
 * 混在一起互相写，那种由 `Effect` 的嵌套上限拦成一条抛错（见 `run()`）。
 */
export function computed<T>(fn: () => T): ReadonlyRef<T> {
  const out = ref<T>(undefined as T)
  // 借用 effect 的依赖记账：`fn` 里读到的信号都会订阅到这条 effect 上
  const e = new Effect(() => {
    out.value = fn()
  })
  scope?.(e)
  return out
}

/**
 * 注册一个副作用：立刻跑一次，之后依赖变了自动重跑。返回句柄以便销毁（见 `Effect.dispose`）。
 * 在组件里调用会自动挂到该组件的销毁清单上（见 `ownedEffects`），组件卸载即停；
 * 运行时内部的绑定不走这条路。
 */
export function effect(fn: () => void): Effect {
  const e = new Effect(fn)
  scope?.(e)
  return e
}

/** 把一批变更合成一次刷新。 */
export function batch<T>(fn: () => T): T {
  depth++
  try {
    return fn()
  } finally {
    if (!--depth) drain()
  }
}

/**
 * 排空 batch 队列。两条要点：
 *
 * 1. **排空期间仍然算批量**（`depth++` 包住这一轮）：跑 effect 时写信号会进队列而非立刻
 *    同步跑 ⇒ 一轮里同一个 effect 最多跑一次；否则"batch 里再改 batch"会当场同步刷。
 * 2. **循环有界**：队列一直不空就是有人互写，抛错而不是转到浏览器卡死。
 */
function drain(): void {
  let round = 0
  while (pending.size) {
    if (++round > MAX_NESTING) {
      pending.clear()
      throw new Error('[lite] 循环更新：batch 队列排不空（超过 ' + MAX_NESTING + ' 轮，检查信号是否互相写）')
    }
    const q = [...pending]
    pending.clear()
    depth++
    try {
      for (const e of q) if (!e.disposed) e.run()
    } finally {
      depth--
    }
  }
}

/**
 * 监听一个信号，**初始不触发**（与 Vue 的 `watch` 一致）—— 靠这一点，模块级监听就不会在
 * 状态尚未就绪时先打一次请求。实现：先读一次当前值（此时没有 active effect，不建依赖），
 * 再放进 effect 里比较。
 *
 * 返回的句柄：组件内创建随组件销毁（见 `ownedEffects`），组件外就用它自己停。
 */
export function watch<T>(source: ReadonlyRef<T>, cb: (value: T, oldValue: T) => void): Effect {
  let old = source.value
  const e = new Effect(() => {
    const v = source.value
    if (!Object.is(v, old)) {
      const prev = old
      old = v
      cb(v, prev)
    }
  })
  scope?.(e)
  return e
}
