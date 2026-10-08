/**
 * `regress/router.mjs` 的临时构建配置：把 `src/router.ts` 打成 **Node 能直接 import 的 ESM**。
 *
 * 为什么不复用 `check.vite.config.ts`：那份的入口与产物名是钉死的（`compiler.ts` → `compiler.js`）。
 * 与其把一份配置改成靠环境变量分叉（读的人要多想一层），不如各留一份、各自一眼看懂。
 *
 * ⚠ 为什么路由测试放 `regress/` 而不是 `demo/`：`demo` 要装无头 Chrome 且**故意不进 CI**
 * （谁改谁本地跑）。路由的判据大多是纯函数（匹配、参数、query、href 拼装），用几个 DOM 桩
 * 就能在 Node 里全测掉 ⇒ 放进 `npm run gates`，CI 每次都会跑到。
 * 真 DOM 的那部分（`popstate`、真实 `history`）留给 `demo`。
 *
 * ⚠ 路径一律绝对：Vite 把相对 `outDir` 当成相对 **root**（= 仓库根）。
 */
import path from 'node:path'
import { defineConfig } from 'vite'

const here = path.dirname(new URL(import.meta.url).pathname)
const tmp = path.join(here, '.check-router-tmp')

export default defineConfig({
  build: {
    outDir: path.join(tmp, 'out'),
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    // ⚠ 扩展名要写全：Vite 8 的 lib 模式不会给 `fileName()` 的返回值补 `.js`
    lib: { entry: path.join(tmp, 'entry.ts'), formats: ['es'], fileName: () => 'router.js' },
  },
})
