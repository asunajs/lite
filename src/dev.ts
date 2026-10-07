/**
 * 是否为**开发构建**。
 *
 * ⚠ 必须是 `import.meta.env.DEV` 这种**构建期可静态替换**的形式：Vite 在 `build` 时
 * 换成字面量 `false`，压缩器随即把 `if (DEV) { … }` 整块折掉 —— 诊断代码（长文案 +
 * `new Error().stack` 抓栈）**不进生产产物**，而在 `vite dev` 里一条不少。
 * 实测 `npm run size`：这条值 **gzip −337 B**（2,808 → 2,471，约 −12%）。
 *
 * ⚠ 不要改成 `globalThis.__DEV__` 之类的**运行时**值：分支折不掉，字符串照旧留在产物里。
 * 各构建入口（`vite.config.ts`、`demo/`、`bench/`、`regress/`、`size.mjs`）都走 Vite，
 * 所以 `import.meta.env` 一定存在；若用裸 esbuild/rolldown 直接打 `src/`，需自行 `define`。
 */
export const DEV: boolean = import.meta.env.DEV
