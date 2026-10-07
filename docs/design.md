# lite —— 设计与现状

> **一句话**：无虚拟 DOM + 编译期绑定的 TSX 前端框架。TSX 在构建时被折成
> "模板串 + 每个动态位置一条 effect"，运行时零依赖、只留真用到的那几个原语。

## 这三份文档怎么分工

* [`guide.md`](guide.md) —— 把 lite 用进新项目的教程（装包 / 拷源码、Vite、tsconfig、
  JSX 类型、语法子集、常见坑）。**想写代码读这份。**
* **本文件** —— 设计与取舍、运行时与编译器怎么分工、体积与性能读数、验收命令、
  明确"不做"的东西。**想改运行时或编译器读这份。**
* [`pitfalls.md`](pitfalls.md) —— 按技术主题整理的"现象 → 根因 → 现在怎么防"。
  **踩到坑读这份。**

---

## 1. 为什么自研

不是为了"不要依赖"，是为了**体积与首屏**。

* 一次对真实 TSX 应用的全量用法普查显示，真正用到的 Vue API 只有 `ref` /
  `onMounted` / `onUnmounted` / `watch` / `useSlots` 这几个；Teleport / Transition /
  KeepAlive / Suspense / 异步组件 / 指令 / `computed` 一处都没用（§2）。
* 框架运行时是一块**每个用户都要下载的地板**：参照 Solid 核心 ≈7 KB gzip、
  Vue Vapor 的运行时地板 ≈16 KB gzip（§5 有现算口径）。

**性能不是自研的理由** —— 目标是"与手写 DOM 操作同量级"，不是赢过谁。

## 2. 语法子集：由普查决定，不是拍脑袋

这套子集来自一次对真实 TSX 应用的全量用法普查。这份普查是"为什么只做这么小"的依据，
框架范围由它定，不随后来加的护栏改变：

| 用到的 Vue API | lite |
|---|---|
| `ref` / `onMounted` / `onUnmounted` / `watch` / `useSlots` | ✅ |
| `computed` / `reactive` / `nextTick` / `provide` / `inject` / `toRef` | ❌ 不做 |
| 指令（`v-if` 等） / 模板引用 / `class` 数组·对象 / `style` 对象 | ❌ 不做 |

TSX 用到的形态同样只有这几种：静态 `class`、动态 `class`、`onXxx` 事件、`key=`、
`{...obj}` 展开、三元条件、`.map()`、片段。

**结论：这个框架要支持的东西非常少** —— 4 个响应式原语 + 一套 JSX 形态。
这是运行时能压到几 KB 的前提，也是"编译器敢把路径算进源码"的前提。

## 3. 运行时

六个文件（`src/` 下的全部），没有第七个：

```
src/index.ts       对外 API 的唯一入口（下面三组导出都从它出去）
src/signal.ts      响应式核心：ref / effect / batch / watch + 组件作用域归属 + 循环护栏
src/dom.ts         template / 各类 setter / insert / remove / lazySlot + 按节点记账
src/control.ts     createFor（键控列表）
src/component.ts   createComponent / mount / onMounted / onUnmounted / useSlots
src/dev.ts         开发态诊断（`DEV = import.meta.env.DEV`，生产构建整块折掉）
```

导出**分三组，别当成同一回事**（`src/index.ts` 的文件头有同样的注释）：

| 组 | 名字 | 谁用 |
|---|---|---|
| 编译器 import 的 | `batch` `effect` `ref` `watch` `createComponent` `createFor` `lazySlot` `on` `remove` `setAttr` `setClass` `setNodes` `setProp` `setValue` `spread` `template` | 改名字 = 编译产物断（`compiler.ts` 里那些 `this.h('…')`） |
| 业务代码手写的 | `mount` `onMounted` `onUnmounted` `useSlots`，类型 `Component` / `Slots` / `Ref` | 页面与 UI 单元 |
| 运行时内部件 | `createNodes` `insert` `onRemove` | 只有 demo / bench / 排障该碰 |

### 3.1 响应式模型：同步刷新 + `batch`，没有调度器

信号一写，受影响的 effect 立刻跑。理由：依赖链只有"信号 → DOM 写入"这一层，
同步执行省掉整套调度器（约 300 B）。要一次改多个信号再统一刷 DOM 就写 `batch()` ——
**事件处理器由编译器自动包**（§4.4），人写的代码只在明显要合批时手动包。

`batch` 的排空是**再入安全**的：排空期间仍算批量（`depth++` 包住这一轮），
所以"batch 里再改 batch"不会当场同步刷，一轮里同一个 effect 最多跑一次。
反过来，旧写法在 `depth` 归零后才跑队列，一次事件能把 DOM 写好几遍。

同步刷新有一个**直接后果**：在渲染 / 挂载的求值还没退栈时写信号，会**重入当前渲染**。
两个真症状（切页时页面被追加、跨视图跳转时新页被无限重建）与规避手法见
[`pitfalls.md`](pitfalls.md) 的「挂载期间写信号 ⇒ 外壳被重入渲染」与
「同步跨视图跳转 ⇒ 新页被无限重建」两节。规则两条：

* **组件挂载路径上不写信号**（要登记回调就用普通模块变量，点击时现读）；
* **跨视图跳转推到下一个任务**（`queueMicrotask`），让处理帧先退栈。

### 3.2 effect 的两种归属（这是运行时的骨架）

* **按节点**（`dom.ts` 的 `owners`）：`setNodes` / `createFor` 建的绑定 effect。
  节点被 `remove()` 摘走时 `disposeTree()` 连带销毁 —— 列表删一行就停那一行的 effect。
* **按组件实例**（`signal.ts` 的 `ownedEffects`）：公开的 `effect()` 与 `watch()` 建的。
  它们不属于任何 DOM 节点（`watch` 只回调、不写 DOM），走不到第一条路，
  于是组件卸载时统一销毁。运行时内部用 `newEffect()`（不挂作用域），公开的 `effect()` 才挂。

两条防线**互补**，都不能少：按父节点记账管不到"父还活着、子树已被别处整块换掉"这一类，
所以 `setNodes` / `createFor` 的 effect 在**重跑之前**先看"我上次插进去的节点还在不在文档里"，
全都不在 ⇒ 它已经脱管，自己 `dispose()` 再返回。判据必须在做任何事之前
（不能先 remove 再判断）。这一条防的是"越刷新内容越多"那种**静默重复插入**。

挂载钩子走同一套记账：`onMounted` 按**实例自己的节点**登记，`insert()` 每插完一次就放行
"已入文档"的那些 —— 所以切页、条件分支里**动态建出来**的组件，钩子照样会跑
（不是只在 `mount()` 那一刻 flush 一次）。

### 3.3 循环护栏

`A → B → A` 这种互写会变成一条**可读的抛错**，而不是把栈打爆：
`MAX_NESTING = 100`（effect 重入层数）与 batch 队列的轮数上限各一道。
错误**不指名**是哪条 effect（给每条存标签是白付的字节），它只把范围收窄到
"是互写，不是数据太多"；这已经比 `RangeError: Maximum call stack size exceeded` 强 ——
爆栈时中途的 DOM 写入早就把现场冲掉了。

## 4. 编译器（TSX → 模板串 + 逐槽 effect）

三个文件分工：

```
compiler.ts   TSX → 运行时调用（唯一需要 oxc-parser 的文件，只写代码生成）
ast.ts        AST 适配层：oxc-parser 的 ESTree → 编译器要的那几个接口
vite.ts       Vite 插件（enforce: 'pre' —— 必须先于下游转换器拿到带 JSX 的源码）
```

结构照 Solid 的 `babel-plugin-jsx-dom-expressions`，两处有意不同：`.map()` 直接编成键控
`createFor`（Solid 的 `.map` 是朴素数组 diff，键控要写 `<For>`），以及不做事件委托（§8）。

### 4.1 静态结构 → 模板串，动态位置由**编译器算好路径**

```tsx
<li class={props.n % 2 ? 'odd' : 'even'} title={`n=${props.n}`}>{props.label}:{props.n}</li>
```
```js
const _t0 = _$template('<li><!---->:<!----></li>')   // 动态 class 不进模板；每个动态位置一个 <!----> 锚点
const _n0 = _t0(), _n1 = _n0.firstChild, _n2 = _n0.childNodes[2]   // ← 路径全在编译期算好
```

这是与 Vapor **唯一真正的架构分歧**：Vapor 把动态位置交给运行期走位
（`template(html, n)` + `child` / `next` / `txt`），lite 让编译器把 `childNodes[i]` 折进源码。
换来运行时少三个走位函数，代价是生成代码长一点。

### 4.2 动态绑定 → 一条 effect；静态表达式不包

```js
_$setNodes(_n1, () => props.label, _n2)                              // 子节点：setNodes 自己管 effect
_$effect(() => _$setClass(_n0, props.n % 2 ? 'odd' : 'even'))         // 属性：包一条 effect
_$effect(() => _$setAttr(_n0, 'title', `n=${props.n}`))
```

生成的 helper 一律带 `_$` 前缀（`import { setNodes as _$setNodes } from 'lite'`），
所以**不会与业务源码里自己 import 的名字撞车**。

* **props 是 getter 不是函数**：产物写 `get 'label'() { return it.label }`，组件里
  `props.label` 直接读 —— 但**不能解构**（解构会丢响应性，读到的是快照）。
* **文本子节点走 `setNodes`，不是 `setText`**：`setNodes` 内部才有"纯文本就只写文本"的
  快路径。
* **子节点绑定外面不套 `effect`**（`setNodes` 自己就是那条 effect），
  而**属性绑定外面要套**（`effect(() => setClass(...))`）。
* **编译期优化**：表达式里不含响应式读取时不包 effect，直接写一次；字面量属性
  （`rows={3}`）**折进模板串**。

### 4.3 事件 / 组件 / 条件 / 列表 / 插槽

```js
_$on(_n2, 'click', (e) => _$batch(() => handler(e)))          // 事件：直接 addEventListener + 自动 batch
_$createComponent(Row, { get 'label'() { return it.label } }) // 动态 props = getter
_$setNodes(_n0, () => show.value ? _t2() : null, _n3)         // 三元 ⇒ setNodes，**没有** createIf 这个原语
_$createFor(_n2, () => items.value, (it, _i) => _$createComponent(Row, {…}), (it, _i) => it.id, _n5, false)
_$setNodes(_n0, () => _$createComponent(Panel, { 'title': 't' }, { default: () => [ … ] }), _n1)  // 插槽 = 函数
```

`createFor` 的最后两个参数：

* **`anchor`** —— 每个动态子节点自带 `<!---->` 占位注释当锚点（位置钉死，重跑多少次都插在
  同一处）；没有锚点就是 `null` = 追加到末尾。
* **`positional`** —— 编译器**结构判断**渲染体里读没读 `.map()` 的索引参数。
  读了 ⇒ 重排时**重建**那一行（行内容真的依赖位置）；没读 ⇒ 重排时把行**搬走**，
  保住行内焦点与输入框光标。Vue 的 keyed diff 不区分这两种，只能一律重建。

### 4.4 自动 batch 是编译器的事，不是运行时的

运行时不背调度器（§3.1），所以**编译器给每个事件处理器包一层 `batch()`**，
把"连续写 N 个信号 ⇒ 刷 N 遍"这条尾巴剪掉。

### 4.5 错误面：哪些写法会拦、哪些会**静默编错**

⚠ 这张表是最容易踩的，写代码前看一遍（[`guide.md`](guide.md) §10 有同一份的展开）。

**会抛错**（带 `文件名:行号`）：

| 写法 | 报的那句 |
|---|---|
| `key` 写在非 `.map()` 返回的元素上（普通元素 / 组件 / 条件分支 / 片段） | 这里的 `key` 什么都不做… |
| `v-if` / `vIf` 这类指令式属性 | 不支持指令式属性（TSX 里没有 Vue 的指令） |
| `@click` 这类 Vue 事件简写 | 源码解析失败（TSX 本身就解析不过；报在 lite 这层，而不是让下游吐一句 `Unexpected token` 的残码） |
| 组件上的 `{...spread}` | 组件上的 {...spread} 未支持 |
| 空元素带子节点（`<img>…</img>` / `<br>x</br>`） | 空元素 `<img>` 不能带子节点（生成 HTML 无法表达） |
| 条件分支的分支不是 JSX 也不是 `null` | 条件分支只支持 JSX 或 null |
| 组件写在静态位置 | 组件只能出现在动态子节点位置 |

⚠ 反过来，**非空元素写自闭合是安全的**：`<label class="x" />` 生成的是
`<label class="x"></label>`（补出闭合标签）。这一条曾经真的是 bug —— 早期生成的是
没有闭合标签的 `<label class="x">`，HTML 里没有自闭合，于是把后面的兄弟全吞进它的子节点，
编译期算的 `childNodes[i]` 整体错位。现在它由产物自己保证，不再是写作禁忌。

**会静默编错**（不抛，产物不对）：`class` 数组 / 对象、`style` 对象、模板引用 `ref=`。
真实项目里 0 处使用 ⇒ 没做检测。**别用**。（小写 `onclick` 同理：只有 `onXxx` 且 `X`
大写才是事件。）

块体 `.map()`（`{items.value.map((it) => { …; return <li/> })}`）**不建 `createFor`** ——
预处理落在 effect 之外，信号读不到会冻住。写成表达式体（真有前置语句就把列表挪出去）。

`xlink:href` / `data-*` / `aria-*` 这些**带冒号或连字符的真属性不是指令**，
负例用例专门守着"别把它们当 `v-` 拦掉"。

### 4.6 解析器与适配层

编译器用 **`oxc-parser`**（原生 napi 包）解析 TSX，`typescript` 包不在依赖里。
`ast.ts` 是一次 **normalize 遍历**：把 oxc 的 ESTree 抹成编译器要的那几个接口，
`compiler.ts` 只写代码生成 —— 换解析器换的是**一条接缝**。

三类真实差异（都是踩出来的）：

1. **字段名**：`Literal.value` vs TS 的 `.text`、`CallExpression.callee` vs `.expression`、
   `JSXOpeningElement.name` vs `.tagName`、`Property.key/value` vs `.name/.initializer`…
2. **包了一层**：TS 的 `openingElement.attributes` 是个 JsxAttributes 节点（数组在
   `.properties` 上），TS 的参数是 ParameterDeclaration（模式在 `.name` 上）——
   适配层**造**同形状节点补上，否则那几处直接读到 `undefined`。
3. **语义口径**：`{/* 注释 */}` / `{}` / `{ }` 三种空表达式容器，TS 一律给
   `expression === undefined`（编译器靠它跳过），oxc 给 `JSXEmptyExpression` 节点 ⇒
   不镜像就会**多吐一个 `<!---->` 锚点**（黄金样本抓出来的）。

⚠ 另有一条**与解析器无关、纯 JS 的坑**：适配层收集节点时写了
`if (Array.isArray(v)) for (…) if (…) push(c)` 后面跟 `else if (…) push(v)` ——
`else` 绑到了**内层** `if` 上，于是"数组子节点进得来、对象子节点永远进不来"，
表现是产物**静默退回原文件**。凡 `if` 里套 `for` 里再套 `if`，一律加花括号。

**怎么证明换对了**（三件，缺一不可）：

1. **18 个 tsx 的产物与换之前逐字节一致**（换之前先把旧产物存成黄金样本）—— 18/18；
2. `regress/compiler.mjs` 的编译期负例行为不变（该抛的都抛）；
3. 应用侧那套页面级验收全绿，且业务产物的 chunk hash 一字未变 —— 端到端等价的最强证据。

**类型检查那条路**与编译器无关，但同样需要一个 TypeScript 实现：`npm run typecheck` =
`tsgo --noEmit`（`@typescript/native-preview`，原生实现）。**只要 tsgo** ——
不要把 `typescript` / `tsc` 加回来做"两条实现互校"。⚠ 已知边界：tsgo 目前是
**7.0.0-dev 预览版**，与 `tsc@5.9.3` 对拍过 7 类代表性错误（错误码、行列、文案逐条相同），
但不等于穷举了两者的每一处差异（`--build` 增量、编辑器级 API 等未验证）。

⚠ `oxc-parser` 是**原生**包 ⇒ 凡把它打进 Node 侧产物的构建都要标 `external`
（见 `regress/check.vite.config.ts`）。

## 5. 体积（实测，`npm run size`）

Vite / Rolldown / es2022 / 默认压缩器的生产构建后 gzip：

| 裁剪 | raw | gzip |
|---|---|---|
| 全量（= `src/index.ts` 导出的全部） | 现算 | 现算 |
| 再去掉只有 demo/bench 用的内部件 | 现算 | 现算 |

> 数字**别背**（每次改运行时都变）：`npm run size` 会把这两行打出来。
> 参照：Solid 核心 ≈7 KB gzip、Vue Vapor 的运行时地板 ≈16 KB gzip ——
> 拿现算的 gzip 去除即可。

口径：

* **raw 才等于二进制差**（运行时若被嵌进别的二进制，差的就是 raw），
  gzip 才是浏览器实际下载量。
* `npm run size` 走 Vite build ⇒ `import.meta.env.DEV` 被折成 `false`，量到的是**生产档**；
  开发档把传给 Vite 的 `define` 改成 `{'import.meta.env.DEV': 'true'}` 再量一次即可。
  诊断代码只在开发态付费 —— 实测这一项值 **237 B gzip**（开发档 raw 5,840 / gzip 2,708，
  当时生产档 2,471）。

### 5.1 体积是怎么涨上来的（护栏与修复的成本）

运行时涨到今天的量级，主要不是功能变多，而是**护栏**：

* 每加一条"崩过的现场"对应的防线（按节点记账销毁 effect、锚点脱开的护栏、
  陈旧 effect 自毁、槽内容的记账），就多一份字节 —— 这些现场见 [`pitfalls.md`](pitfalls.md)。
* 中间删过一批"只为兼容别的框架词汇表而留"的东西（`computed` / `createStore` /
  `renderEffect` 这些别名），同时加上 effect 的组件作用域归属、`batch` 的再入排空、
  循环护栏，净 **+187 B gzip**。
* 也往回走过：诊断代码改成**编译期剥离**（`src/dev.ts` 的 `DEV = import.meta.env.DEV`）
  一次 **−337 B gzip**，且没删任何功能 —— 开发态告警一条不少，只是不再进生产产物。
  同批还去掉了只给告警用的"调用方标签"参数（生产折掉告警后字符串仍留在产物里）。
* 修内存泄漏（列表行内 effect 挂到行节点下）又加回一点。

⇒ **字节是全局税**：判断"要不要为一个能力加运行时"时，按 §8.0 的账算。

## 6. 性能（实测，`npm run test:bench`）

**测的是编译产物**：`bench/bench.tsx` 是一份正常写法的 TSX，由 lite 插件编译。
（早期引的是手写目标形态的裸速读数，口径偏乐观：那量的是运行时下限，
没把"编译器产物的质量"算进去 —— 少不少一条 effect、路径有没有静态算好。）

best of 3、headless Chrome、1000/2000 行的合成规模：

| 操作 | 编译产物 | 手写目标形态（旧口径，仅作参照） |
|---|---|---|
| 挂载 1000 行 | **2.5–5.9 ms** | 1.2 ms |
| 改一处文本 ×100 | ~0 ms（触到计时精度） | 0.1 ms |
| 改三处文本 ×100 | ~0 ms | 0.2 ms |
| 追加 100 行 ×10 | **4.2–7.0 ms** | 2.6 ms |
| 同序重排 2000 行 ×10（纯 diff） | **1.8–2.5 ms** | 1.7 ms |
| 反转 2000 行 ×10 | **8.6–12 ms** ⚠ | 8.6 ms |
| 卸载 | **4.2–5.0 ms** | 0.1 ms |

三条读数要说清：

1. **每次跑都在动**（同一台机器挂载能在 2.5～8 ms 之间跳），看量级别看小数。
   `run.mjs` 退出码非 0 的条件不是"变慢了"，而是**断言红了**（行数、首末行文本、
   追加/重排是否保留节点身份、卸载后是否清空）—— 数字只有在断言全绿时才有意义。
   卸载那一项从 0.1 ms 变 4 ms 也是同一回事：手写版根本没给 `remove()` 记账。
2. **`batch` 与非 batch 在这档规模下测不出差别**（三项都在亚毫秒、触到
   `performance.now()` 精度）。要拉开差距得给每处文本挂几十条绑定，那不是常见页面的形状。
3. **反转仍是劣化项**：逐行搬，没有"最小移动集"。2000 行反转 ≈1 ms/次；
   实际页面的列表通常在几十行量级，那一档是亚毫秒。
   **什么情况下该回来做**：某一页 routinely 上千行**且**会整段颠倒（追加不在此列）。

## 7. 验收与门禁

框架侧的门就是 `package.json` 里的 npm 脚本（**都在仓库根目录跑**）：

| 门 | 命令 | 证明什么 |
|---|---|---|
| typecheck | `npm run typecheck`（**`tsgo --noEmit`**，原生 TS） | 类型与 JSX 命名空间对得上 |
| build | `npm run build` | 全量 TSX 编得过、`dist/` 能出（`dist/` **入库** —— git 依赖装完即用，CI 另有一条"`dist` 与源码同步"兜住漂移） |
| 编译期负例 | `npm run test:compiler` | **该抛的都抛了**：四种 `key` 位置、两种指令写法、`@click`、块体 map、`positional` 真假、带冒号的命名空间属性不该被拦。纯 Node，不需要浏览器 |
| 真 DOM 验收（demo） | `npm run test:demo` | 编译真实 TSX（`ref` / `.value` / 钩子 / `watch` / 插槽 / 片段 / 键控列表）→ 无头 Chrome → 行为断言，跑的是编译产物 |
| 编译产物行为 + 耗时护栏（bench） | `npm run test:bench` | 编译 `bench.tsx` → 行为断言 + 耗时表；判负条件是页面抛错、任一断言 FAIL、或挂载 1000 行 > 500 ms（那通常意味着列表从"搬节点"退化成"重建整表"） |
| 体积 | `npm run size` | 运行时体积两档口径（§5） |
| 汇总（纯 Node 三条） | `npm run gates` | typecheck + build + test:compiler |

⚠ **断言条数以脚本自己打印的那行为准，别背**（源码在长，写死的数字迟早说谎）：
编译期负例现在是 `regress/compiler.mjs` 的 `CASES.length`（当前 13 条），
demo 与 bench 看各自最后那行输出。

⚠ 没装无头 Chrome 的机器上 `test:demo` / `test:bench` **会直接失败**（脚本按
`~/.cache/puppeteer` 的落点找 `chrome-headless-shell`，找不到就 spawn 不出来）——
它不会印"跳过"、更不会冒充绿。

⚠ **这两条故意不进 CI**（`.github/workflows/ci.yml` 只有一个 `gates` job：`npm run gates`
+ 一条"`dist` 与源码同步"的检查，纯 Node、跑得飞快）。要装浏览器就得在 CI 里拉一份
几十 MB 的 Chrome、还挑机器，而它们回答的问题（"这份产物在真 DOM 上对不对"）
**谁改框架谁跑一次**更直接：

```bash
LITE_CHROME_NO_SANDBOX=1 npm run test:demo && npm run test:bench
```

⚠ **无头 Chrome 的启动参数只有一份：`chrome-flags.mjs`** —— `demo/run.mjs` 与
`bench/run.mjs` 都从 `headlessFlags()` 取公共前缀（`--headless` [+ `--no-sandbox`]
`--disable-gpu`），私有参数（`--hide-scrollbars` / `--window-size` /
`--virtual-time-budget` / `--dump-dom` / URL）各留各的。别各写一份参数表：两份迟早漂移。

⚠ `--no-sandbox` **默认关**（那是降级：渲染进程不再与内核隔离）。某些环境里
`chrome-headless-shell` 不带它直接 `Target crashed` / `CDP 调用超时：Page.enable`，
那时**显式**打开：

```bash
LITE_CHROME_NO_SANDBOX=1 npm run test:demo     # 或 npm run test:bench
```

环境变量会穿过 git 钩子（`pre-commit` / `pre-push` 继承当前环境）⇒ 过钩子不用改文件。
`=0` / `=false` / `=no` 都当没开。

⚠ 框架侧只管"编译器 / 运行时 / 自己的夹具"。**页面级验收**（在真浏览器里点页面、
量窄屏、量泄漏）属于应用自己的事，不在这个仓库。

## 8. 风险与明确的"不做"

### 8.0 框架不够用时："改框架"与"绕开"摆上秤，比一比再选

**别默认绕**，也别默认改。三选一，并把账算给人看：

| 选项 | 付什么 | 赚什么 |
|---|---|---|
| **① 绕开**（改页面写法 / 换控件 / 改需求） | 只付这一个地方；可能留下"这行代码为什么这么怪"的注释债 | 框架与全站零风险 |
| **② 改框架**（加语法 / 加运行时能力） | **每个用户都付字节**（§5 是逐字节量过的）+ 全部页面一起承担回归风险 | N 个调用点从此自然 |
| **③ 先不做**（明确写进本节的"不做"） | —— | 逼出一个不需要该能力的方案 |

判据：

1. **字节是全局税**：框架侧 +200 B ≈ 全站每个用户 +200 B；页面侧绕一下 ≈
   只在那一个页面里绕。**同一个"绕"在第 3 处出现**，才是"该改框架"的证据
   （第 1 处是巧合，第 2 处是重复，第 3 处是规律）。
2. **能撤的直接试，撤不回的才慎重**：页面级写法随时可改；**改运行时 / 编译器**
   动的是全体页面，改完必须跑 §7 的门。
3. **"绕"要写明代价**：注释里写清"为什么这么怪"和"框架侧要什么才能不绕"
   （例：`.map` 的 `key` 必须挂在 JSX 元素的子表达式位置，这是编译器的刻意约束）。

| 项 | 说明 |
|---|---|
| 只测过 Chrome | Safari / Firefox 未验；用的都是标准 API，但没有实测 |
| 异步组件 / 代码分割 | 框架不提供专门 API：动态 `import()` 与条件渲染是普通 JS，由使用者自己组织 |
| SSR / 水合 | 不做：运行时需要真 DOM |
| 指令、模板引用、`class` 数组/对象、`style` 对象 | 0 处使用，**不做**，也**不检测**（§4.5 的静默区） |
| 事件委托 | 不做：逐元素 `addEventListener`；委托要额外付约 250 B gzip，并引入"事件目标穿过 shadow / `stopPropagation`"这类边界 |
| LIS（整表反转快路径） | 不做，理由同 §6（反转是唯一的劣化项）—— 拿"每个用户都付的字节"换"少见场景" |
| Vue 兼容层 | 不做：不提供 `computed` / `createStore` / `renderEffect` 这类别名，也不提供 `'vue'` alias |

## 9. 复现命令（都在仓库根目录跑）

```bash
npm run gates            # typecheck + build + 编译期负例（纯 Node 三条，最快的一轮自检）
npm run size             # 运行时体积（两档口径）
npm run test:compiler    # 编译期负例（纯 Node，不需要浏览器）
npm run test:demo        # 编译 TSX demo → 无头 Chrome → 行为断言（条数看它自己那行）
npm run test:bench       # 编译 bench.tsx → 无头 Chrome → 耗时表 + 行为断言
```

临时产物只落 `/tmp` 与 `regress/.check-tmp`、`.size-tmp`（已在 `.gitignore`）。

## 10. 还剩什么

1. Safari / Firefox 实测（§8 第一条风险，需要在真实浏览器里跑）。
2. 体积基线的定期复测：§5 的读数每次都要连口径（工具链、裁剪档）一起写。
