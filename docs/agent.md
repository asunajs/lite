# 给 agent 的契约

> **这一页是给"在别的项目里用 lite"的 agent 看的**（人同样适用）。目标是一屏之内知道：
> 硬约束、编译器管什么、哪里会**静默**出错。
>
> **别顺手读别的**：`guide.md` 是完整教程（要用的时候查），`design.md` 只有**要改框架本身**
> 才需要读，`pitfalls.md` 是"已经踩到了"再去对症状的地方。读多了只是把上下文塞满。

## 1. 三句话讲清它是什么

* **无虚拟 DOM + 编译期绑定**：TSX 在构建期被折成"模板串 + 每个动态位一条 effect"，
  运行期不做 diff、不解析模板、不 `eval`。
* **组件函数体只跑一次**：没有重渲染；**写 `.value` 那一刻 DOM 就变了**（同步，没有 `nextTick`）。
* 运行时交的是 **TS 源码**，由**使用方的打包器**编译 ⇒ 必须接上 Vite 插件。

## 2. 接线（照抄）

```ts
// vite.config.ts
import lite from '@asunajs/lite/vite'
export default defineConfig({ plugins: [lite({ runtime: '@asunajs/lite' })] })
```

```jsonc
// tsconfig.json —— 两处都必须有
{ "compilerOptions": {
    "jsx": "preserve",                              // ⚠ 别让 TS 去处理 JSX
    "types": ["vite/client", "@asunajs/lite/jsx"]   // 全局 JSX 声明；少了每个标签报 TS7026
} }
```

⚠ 不要写 `jsxImportSource`（会让上面那份全局声明整个失效）。

## 3. API（能手写的是前三类，第四类别碰）

| 分类 | 导出 |
|---|---|
| 状态 | `ref`（读写作 `.value`）`computed`（派生 + 缓存，**只读**）`effect` `batch` `watch` |
| 组件 | 普通函数组件 + `mount(App, '#app')` `useSlots` `onMounted` `onUnmounted`；类型 `Component` `Slots` `Ref` |
| 编译器产物用 | `template` `setNodes` `setClass` `setAttr` `setProp` `setValue` `on` `spread` `createFor` `createComponent` `lazySlot` `remove` |
| 运行时内部件 | `createNodes` `insert` `onRemove` |

`mount()` **返回卸载函数**：`const unmount = mount(App, '#app')`，调用它跑 `onUnmounted` 并摘干净。

⚠ `computed` 是**急**的（依赖一变就算，哪怕当轮没人读）；它真正的收益是**去重** ——
派生值没变（`Object.is`）就不惊动下游 effect。只想"读一眼当前值、不订阅它"用 `untrack(() => …)`。
⚠ 这两个（以及 `watch`）编译器**不生成** ⇒ 用不到就整段被摇掉，不占体积（`computed` 用上 +46 B gzip）。

## 4. 硬约束（违反的后果写在后边）

| 约束 | 违反会怎样 |
|---|---|
| 组件体**只跑一次** ⇒ 派生值必须写在 JSX 里 | 顶层算出来的值是**死的**，永远不更新 |
| 更新**同步** ⇒ 一次改多个信号要 `batch()` | 中间态会被渲染出去（可能多跑几次 effect） |
| 状态惯例是**模块级 `ref`**（要按实例隔离就在组件体内 `ref()`） | 在组件体外乱建/乱共享，卸载后仍在跑 |
| **挂载路径上不要写信号** | 重入渲染：旧节点不替换、新节点被追加（页面越挂越多） |
| **跨视图跳转推到下一个任务**（`queueMicrotask`） | 新页被无限重建 |
| `.map()` 的 `key` 只能挂在**元素**上，且回调是"箭头 + 直接返回 JSX" | 位置错 / 报错 / 退化成整表重建（见下） |
| 别手动增删或搬动框架生成的节点 | 动态位置靠占位注释定位，搬了就错位 |

## 5. 静默编错速查（**编译不报、运行期也不报**）

| 写法 | 实际结果 |
|---|---|
| `class={['a','b']}` | `class="a,b"` —— **class 只接字符串** |
| `style={{ color: 'red' }}` | `style="[object Object]"` —— **style 只接字符串** |
| `ref={el}`（模板引用） | 元素上多一个字符串属性，**没有模板引用这回事** |
| `onclick={fn}`（小写） | 属性值是函数源码，**不是事件**（判据：`on` 开头 + 第三个字符大写） |
| 块体 `.map()` 回调（`=> { … return <li/> }`） | 不建 `createFor`，退化成整块重建（`key` 被忽略） |

这些**会抛错**（编译器直接拒绝）：非 `.map()` 位置的 `key`、指令式属性（`v-if` 那一族）、
`@click` 简写、组件上的 `{...spread}`、空元素带子节点、条件分支不是 JSX/`null`、
组件写在静态位置。

## 6. 列表复用：什么时候搬、什么时候重建

* `key` 用**稳定 id**；拿下标当 key ⇒ 数据一重排等于每行重建。
* 渲染体**读了下标**（`.map((x, i) => … 第 {i+1} 步 …)`）⇒ 位置是内容的一部分 ⇒ **重排时重建那一行**；
  没读 ⇒ **搬动**（保住行内焦点、光标、滚动位置）。
* 想知道某一处编成了哪种：看产物里 `createFor` 的最后一个布尔参数。

## 7. 归属与销毁（漏了会"越用越多"）

* 编译器生成的绑定按**节点**记账：节点被摘走时连带销毁。
* 组件体内手写的 `effect()` / `watch()` 按**组件实例**记账，卸载即停。
* **只有模块级（组件外）建的** effect 要自己 `dispose()`。
* 列表**行内**的 effect 必须挂在行节点下，否则删行收不掉。

## 8. 改完必须跑

```bash
# 使用方项目
npm run typecheck        # 类型（本框架仓用 tsgo --noEmit；tsc 也行）
npm run build            # 产物必须编得过

# 如果你改的是框架本身（框架仓根目录）
npm run gates            # typecheck + build + 编译期负例（纯 Node）
LITE_CHROME_NO_SANDBOX=1 npm run test:demo   # 真 DOM 验收（要无头 Chrome）
LITE_CHROME_NO_SANDBOX=1 npm run test:bench  # 产物行为 + 耗时护栏
```

⚠ 后两条**没装浏览器会直接失败**（不印"跳过"、不冒充绿）⇒ 别把"CI 绿"当成"验过"。

## 9. 去哪查（按代价从小到大）

| 想看什么 | 去哪 | 代价 |
|---|---|---|
| 硬约束、静默坑 | **这一页** | 一屏 |
| 怎么用、语法子集、接进项目的坑 | [`guide.md`](guide.md) | 一页起 |
| "我踩到 X 了" | [`pitfalls.md`](pitfalls.md)（按症状分节） | 一节 |
| 为什么这么设计、要改框架 | [`design.md`](design.md) | 大 |

框架仓本身的作业须知（门禁、`dist/` 入库、不要加 `typescript` 包）在仓库根的
[`AGENTS.md`](../AGENTS.md)。
