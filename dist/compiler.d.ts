/**
 * lite 的编译器：TSX → 目标形态。结构**参考 Solid 的 `babel-plugin-jsx-dom-expressions`**
 * （把它的真实输出调出来逐条对过，见 docs/design.md §4）。
 *
 * ```tsx
 * const Row = (props: { label: string; n: number }) => (
 *   <li class={props.n % 2 ? 'odd' : 'even'}>{props.label}:{props.n}</li>
 * )
 * ```
 * 编译成（就是 Solid 那套形状）：
 *
 * ```js
 * const _t0 = template('<li>:')
 * const Row = (props) => (() => {
 *   const _n0 = _t0(), _n1 = _n0.childNodes[1]
 *   setNodes(_n0, () => props.label, _n1)   // 插在静态的 ":" 之前
 *   setNodes(_n0, () => props.n, null)      // 末尾 ⇒ 锚点 null
 *   effect(() => setClass(_n0, props.n % 2 ? 'odd' : 'even'))
 *   return _n0
 * })()
 * ```
 *
 * 从 Solid 那里学到的四条（都是实打实省字节/省 DOM 操作的）：
 *
 * 1. **模板里折进静态 HTML**（`template()` + 克隆）—— 这部分照 Solid。
 *    ⚠ **锚点不是 Solid 那一套**：Solid 拿"后面那个静态兄弟"当锚点、末尾则 `null`；
 *    这里给**每个动态子节点各配一个 `<!---->` 占位注释**并拿它当锚点（见上面的产物）。
 *    理由是实测出来的坑（docs/postmortem.md §11.2 第 6 条）：两个相邻的动态子节点
 *    若都没有静态兄弟可当锚点，就都退化成"追加到末尾"，**顺序取决于谁的 effect 后跑** ——
 *    而其中一个的数据是异步来的 ⇒ 界面顺序随机。占位注释把位置钉死，重跑多少次都在同一处。
 *    ⚠ 也正因为锚点是**我们自己的节点引用**，它会被别处摘走 ⇒ `insert()` 里有护栏，
 *    见 docs/postmortem.md §12.3 / §12.5。
 * 2. **每个 JSX 表达式编译成一个立即执行的箭头函数** ⇒ 语句都待在自己的块里，
 *    编译器不必往宿主函数里插语句。
 * 3. **动态 prop 用 getter**（Solid 与 Vapor 在这里不同：Solid 用 getter、Vapor 用函数）。
 *    getter 的好处是运行期零魔法 —— 不用去猜"这个值是 prop 还是回调函数"。
 * 4. **条件分支不需要专门的原语**：`{c ? <A/> : null}` 就是
 *    `setNodes(parent, () => c ? A() : null, anchor)`。所以运行时里没有 `createIf`。
 *
 * 与 Solid 的**两处有意不同**：
 * * `.map()` 编译成键控的 `createFor`（Solid 的 `.map` 是朴素数组 diff，键控要写 `<For>`）；
 *   本项目的源码写的是 `.map` + `key=`。这里**不要求回调返回 JSX 字面量**：
 *   `(item) => navLink(item.id)`、带 `return` 的块体一样进 `createFor`（拿不到 `key`
 *   就退回索引键）。少了这一步，导航那一列每次切页都会整块重建，而它本来只需改 9 个 class。
 * * 事件不委托（Solid 用 `$$click` + `delegateEvents`）：见 docs §8，那是下一步的候选。
 *
 * ⚠ 只支持 `docs/design.md` §2 普查到的语法子集。**拦不拦分两类，别看错**（都是实测）：
 *
 * * **直接抛错**：指令式属性（`v-if` / `vIf` 这种形状）、`.map` 之外的 `key`、
 *   组件上的 spread、空元素带子节点、块体 map 拿不到返回值那类写法 —— 见
 *   `regress/compiler.mjs` 的 12 条负例；
 * * **静默编错**（不抛，产物是错的）：`class` 数组 / `class` 对象 / `style` 对象 /
 *   `ref=` / 小写 `onclick=`。例如 `class={[a,b]}` 原样进 `setClass` ⇒ `String(数组)`，
 *   而 `ref={el}` 变成 `setAttr(el, "ref", fn)`。
 *   ⚠ **这五条不检测**：全仓 0 处使用，加拦截等于为"不存在的需求"付字节，
 *   还会误伤同名的普通属性（`ref` 在 HTML 里本来就是合法属性名）。
 *   别指望类型检查兜住 —— jsx 属性是 `any`（`jsx.d.ts`）。
 *
 * ⚠⚠ **`key` 写在 `.map` 之外的位置也直接抛错。** 它是从 React/Vue 带来的肌肉记忆，
 * 而这里没有"按 key 决定复不复用"的那一次 diff —— `key` 只有一个消费者：`.map` 那一列的
 * `createFor`。写在别处（条件分支、普通元素）会被**静默丢掉**，于是攒出三层错位：
 * 代码里写着 `key`、注释解释"key 不能省"、界面上它其实什么都没做。
 * 编排页的步骤列表曾因此"点了不刷新"（docs/review/review-qwen3.8f-260929.md §1.2）。
 * 宁可编译不过，也别让人带着一个假的安全走动。
 */
export interface CompileResult {
    code: string;
    helpers: Set<string>;
}
/** 编译一个 TSX 源文件。 */
export declare function compile(source: string, options?: {
    runtime?: string;
    filename?: string;
}): CompileResult;
