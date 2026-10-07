/**
 * 产出 `dist/` —— **只装两个 Node 侧入口**（`./vite` 与 `./compiler`），不是整个包。
 *
 * # 为什么只有这两个要编译
 *
 * 包对外有四个入口（见 package.json 的 `exports`），但它们的"消费者"不是同一类：
 *
 * | 入口 | 谁吃它 | 交什么 |
 * |---|---|---|
 * | `.`（运行时） | **打包器**（Vite） | **TS 源码** —— 不能预编译，见下 |
 * | `./vite` `./compiler` | **Node**（`vite.config.ts` 里 import） | **JS** |
 * | `./jsx` | TypeScript 编译器 | 只有 `.d.ts`，本来就没有运行时代码 |
 *
 * 运行时**不能**预编译成 JS：`src/dev.ts` 靠 `import.meta.env.DEV` 在**消费方**的构建里
 * 被静态替换（生产折掉诊断代码、开发保留）。在这里先打一遍，那句就被换成字面量 `false`
 * ⇒ 所有消费方的开发模式都失去诊断 ✗（Vite 的 lib 构建确实会替换掉它）。
 *
 * 而 `./vite` / `./compiler` **必须**是 JS：Node 的 ESM 加载器拒绝对 `node_modules` 下的
 * 文件做类型剥离 —— 原话是
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING: Stripping types is currently unsupported
 * for files under node_modules`，整个 `vite build` 会停在"加载配置"这一步 ✗。
 *
 * # 为什么 `dist/` 入库
 *
 * 本包当前的主要引用方式是 **git 依赖**。npm 对 git 依赖只有在包里有 `prepare` 脚本时
 * 才会装 devDependencies 并构建 —— 那会让每次安装都拉一遍 vite，且构建一失败安装就失败 ✗。
 * 所以走"**产物入库 + CI 校验产物与源码同步**"（见 `.github/workflows/ci.yml` 的
 * `dist 与源码同步` 一步）：安装永远不构建，而漂移在 CI 上一定会红 ✓。
 *
 * # 顺序
 *
 * 先 Vite（`emptyOutDir: true` 会把 `dist/` 清空）→ 再补 `.d.ts`。
 * 反过来的话第一半会把第二半删掉。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { build } from 'vite'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

// ── 1) JS：两个 Node 侧入口 ────────────────────────────────────────────────
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    // 不压缩：这是给人看的库产物，压缩只在消费方的最终产物里做（那一步本来就会做）
    minify: false,
    sourcemap: false,
    lib: {
      entry: { vite: path.join(root, 'vite.ts'), compiler: path.join(root, 'compiler.ts') },
      formats: ['es'],
    },
    rollupOptions: {
      // ⚠ `oxc-parser` 是**原生**包（napi 二进制），打不进 bundle 也不该打进去
      external: ['oxc-parser'],
      // 两个入口共用编译器 ⇒ 打包器会切一个共享 chunk。默认文件名**带内容哈希**，
      // 而 `dist/` 是入库的 ⇒ 每改一行编译器就多一对"删一个文件、加一个文件"的 diff ✗。
      // 名字钉死，内容照样随源码变（CI 的同步检查仍然有效）。
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name].js' },
    },
  },
})

// ── 2) 类型：只给上面那两个入口配 `.d.ts` ──────────────────────────────────
execFileSync(path.join(root, 'node_modules', '.bin', 'tsgo'), ['-p', path.join(root, 'tsconfig.build.json')], {
  cwd: root,
  stdio: 'inherit',
})

console.log('✓ dist/ 已产出（vite.js / compiler.js + 对应 .d.ts）')
