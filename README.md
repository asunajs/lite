# lite

**无虚拟 DOM + 编译期绑定的 TSX 前端框架。** 运行时零依赖；TSX 在构建期被折成
"模板串 + 每个动态位置一条 effect"，之后只有**读过某个状态的那一处 DOM**会被更新。

```tsx
import { mount, ref } from '@asunajs/lite'

const Counter = () => {
  const n = ref(0)
  return <button onClick={() => n.value++}>点了 {n.value} 次</button>
}

mount(Counter, '#app') // 第二个参数也接元素：mount(Counter, document.body)
```

| | |
|---|---|
| **运行时** | 6 个文件、**零依赖**（只用 DOM 与 ES2022），`src/**` 不 import 任何包 |
| **构建期** | `vite`（插件宿主）+ `oxc-parser`（编译器用它解析 TSX） |
| **需要** | 真 DOM（**没有 SSR / 水合**）、构建目标 ES2022 起 |
| **没有** | 虚拟 DOM、`computed` / `reactive` / `nextTick`、`provide`/`inject`、Teleport / Transition / Suspense、异步组件、指令（`v-if` 那一族）、事件委托、模板引用（`ref=`） |

它刻意**小**：语法子集由"真实项目里到底用了什么"普查决定，不含"以后可能用得上"的东西。
范围与取舍见 [`docs/design.md`](docs/design.md)，踩坑排查见 [`docs/pitfalls.md`](docs/pitfalls.md)。

## 安装

```bash
npm i -D @asunajs/lite oxc-parser
```

`oxc-parser` 是本包的**直接依赖**（编译器用它解析 TSX），正常不需要你手动装；
写成上面这样只是让"构建期到底要什么"一眼可见。类型检查另需一个 TypeScript 实现
（`typescript@5` 的 `tsc --noEmit`，或原生的 `tsgo --noEmit`）。

当前尚未发布到 npm registry，用 git 依赖即可（版本号即 tag）。
⚠ 写**完整的 `git+https://`**，别用 `github:owner/repo` 简写 —— npm 会把那个简写解析成
`git+ssh://`，而 SSH 对**公开仓**也要密钥 ⇒ CI 与"没有配 SSH 的人"一律装不上 ✗（实测）。

```jsonc
// package.json
"devDependencies": {
  "@asunajs/lite": "git+https://github.com/asunajs/lite.git#v0.1.2",
  "vite": "^8.3.0"
}
```

## 接进 Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import lite from '@asunajs/lite/vite'

export default defineConfig({
  plugins: [lite({ runtime: '@asunajs/lite' })],
})
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "jsx": "preserve",          // ⚠ 由 lite 的插件编译 JSX，别让 tsc 动它
    "moduleResolution": "bundler",
    "types": ["vite/client", "@asunajs/lite/jsx"], // ← 全局 JSX 类型（少了每个标签都报 TS7026）
    "target": "ES2022"
  }
}
```

⚠ **不要写 `jsxImportSource`**：那条路是给 React/Vue 那类"从 JSX 运行时导入"的框架用的，
一写就会去读那个包的模块声明，`@asunajs/lite/jsx` 这份全局声明**整个失效**。

## 包结构：为什么一半是源码、一半是产物

| 入口 | 交出去的东西 | 为什么 |
|---|---|---|
| `@asunajs/lite` | **TS 源码**（`src/*.ts`） | 运行时必须由**你的**构建器编译：`src/dev.ts` 靠 `import.meta.env.DEV` 在你的构建里被静态替换（生产折掉诊断代码、开发保留）。若在这里先编译一遍，那句就变成字面量 `false` ⇒ 所有使用者的开发模式都失去诊断 |
| `@asunajs/lite/vite` | `dist/vite.js` + `.d.ts` | 它在 **Node** 里被 `vite.config.ts` import。Node 拒绝对 `node_modules` 下的文件做类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，实测）⇒ 必须交 JS |
| `@asunajs/lite/compiler` | `dist/compiler.js` + `.d.ts` | 同上。给"想接 Vite 之外的打包器"的人直接调 `compile()` |
| `@asunajs/lite/jsx` | `jsx.d.ts`（只有类型） | 全局 `JSX` 命名空间声明，零运行时代码 |

`dist/` **入库**（git 依赖因此不需要构建就能用），漂移由 CI 的「dist 与源码同步」一步兜住
—— 细节与理由见 [`scripts/build.mjs`](scripts/build.mjs) 的文件头。

**需要 Vite（或任何能编译 TS 的打包器）。** 运行时是 TS 源码，所以裸 Node、
`file://` 直接 import 都用不了它 —— 这是刻意的：本框架的整个前提就是"JSX 在构建期被折掉"。

## API

业务代码只会用到这些（`src/index.ts` 的全部导出）：

| 分类 | API |
|---|---|
| 状态 | `ref` `effect` `batch` `watch` |
| 组件 | 普通函数组件 + `mount` `useSlots` `onMounted` `onUnmounted`；类型 `Component` / `Slots` / `Ref` |
| 编译产物用 | `template` `setNodes` `setClass` `setAttr` `setProp` `setValue` `on` `spread` `createFor` `createComponent` `lazySlot` `remove` |
| 运行时内部件 | `createNodes` `insert` `onRemove` |

后两类**不要手写**：第三类是编译器生成的代码调的，第四类连编译器都不直接用。

## 三条最容易踩的前提

1. **没有重渲染。** 组件函数体只跑一次，之后更新由编译期生成的细粒度绑定各自负责
   ⇒ 组件体顶层算出来的值是**死的**，派生值必须写进 JSX。
2. **更新是同步的。** 写 `.value` 那一刻 DOM 就变了（没有 `nextTick`）；一次改多个信号要
   合成一次刷新就用 `batch()`。
3. **状态惯例是模块级 `ref`。** "建一个只导出 ref 的模块，谁 import 谁用"就是这个框架的
   状态管理；要按实例隔离，就在组件体内 `ref()`（组件体只跑一次，正好一个实例一份）。

完整教程（语法子集、坑、接入步骤）见 [`docs/guide.md`](docs/guide.md)。

## 开发

```bash
npm ci
npm run gates          # typecheck + build + 编译器负例（纯 Node，CI 跑的就是它）
npm run test:demo      # 真 DOM 验收（要无头 Chrome）
npm run test:bench     # 编译产物行为断言 + 耗时护栏（要无头 Chrome）
npm run size           # 量运行时体积（生产构建 + gzip）
```

无头 Chrome 从 `~/.cache/puppeteer/chrome-headless-shell/*/` 找；受限沙箱里起不来时，
显式开一次降级开关：`LITE_CHROME_NO_SANDBOX=1 npm run test:demo`。

```
src/            运行时：signal / dom / control / component / dev / index
compiler.ts     TSX → 运行时调用（唯一需要 oxc-parser 的文件）
ast.ts          AST 适配层（oxc-parser 的 ESTree → 编译器要的接口）
vite.ts         Vite 插件
jsx.d.ts        全局 JSX 类型声明
dist/           ./vite 与 ./compiler 的编译产物（入库，见上）
demo/ bench/    真 DOM 验收 / 性能基准（框架自己的门）
regress/        编译器负例与形态断言
docs/           教程、设计取舍、踩坑排查
```

## 许可

[MIT](LICENSE)
