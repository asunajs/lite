/**
 * lite 编译器：TSX → 模板串 + 逐槽 effect。结构参考 Solid 的 babel-plugin-jsx-dom-expressions。
 *
 * `<li class={p.n % 2 ? 'odd' : 'even'}>{p.label}:{p.n}</li>` 编译成：
 * ```js
 * const _t0 = template('<li>:')
 * const _n0 = _t0(), _n1 = _n0.childNodes[1]
 * setNodes(_n0, () => p.label, _n1)          // 插在静态的 ":" 之前
 * setNodes(_n0, () => p.n, null)             // 末尾 ⇒ 锚点 null
 * effect(() => setClass(_n0, p.n % 2 ? 'odd' : 'even'))
 * ```
 * 1. 静态结构折进 `template()` 克隆；动态位置在模板里只留一个占位注释，路径由编译器算好。
 * 2. 每个 JSX 表达式编成一个立即执行的箭头函数 ⇒ 语句待在自己的块里，不必往宿主函数插语句。
 * 3. 动态 prop 用 getter（Solid 同款，Vapor 用函数）：运行期零魔法，不必猜值是 prop 还是回调。
 * 4. 与 Solid 有意不同：`.map()` 编成键控 `createFor`（不要求回调返回 JSX 字面量）；事件不委托
 *    （Solid 用 `$$click` + `delegateEvents`）。与 Vapor 的取舍见 docs/pitfalls.md「与 Vapor 的已知差异」。
 * 5. 占位注释就是锚点（为什么不能用"后面那个静态兄弟"，见 `dynChild`）；事件处理器自动包 `batch`。
 * ⚠ 只支持一个语法子集：哪些写法抛错、哪些会静默编错见 `checkDirective` / `claimKey` / `mapCallback`。
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
