/**
 * 量 lite 运行时自己的体积。
 *
 * 方法：把它当成一个库、用**与真实产物完全相同的工具链**（Vite / Rolldown / es2022 /
 * 默认压缩器）打一遍，再 gzip —— 量的必须是"消费方真正会下载到的那份"，
 * 不是源码行数换算出来的估算。
 *
 * 用法：npm run size
 */

import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'

const dir = path.dirname(new URL(import.meta.url).pathname)
const src = (f) => path.join(dir, 'src', f)
const tmp = path.join(dir, '.size-tmp')

/**
 * 两档裁剪，说明"按需删模块"还能省多少。
 *
 * ⚠ 第二档的清单必须与**编译器产物真正 import 的那批**对齐（= `compiler.ts` 里所有
 * `this.h('…')` 加上组件/挂载那几个）—— 那才是"任何页面都得付的地板"。
 * ⚠ `computed` 这类**只给业务代码用**的 API **不在**这一档：编译器不生成它，
 * 用不到就整段被摇掉（边际代价见文件末尾的"典型页面"表）。
 */
const variants = {
  '全量（= src/index.ts 导出的全部）': `export * from '${src('index.ts')}'`,
  '编译器产物那批（= 任何页面的地板）': `
export { batch, effect, ref, watch } from '${src('signal.ts')}'
export { createComponent, mount, onMounted, onUnmounted, useSlots } from '${src('component.ts')}'
export { createFor } from '${src('control.ts')}'
export { lazySlot, on, remove, setAttr, setClass, setNodes, setProp, setValue, spread, template } from '${src('dom.ts')}'`,
}

fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
const rows = []
for (const [name, code] of Object.entries(variants)) {
  const entry = path.join(tmp, 'entry.ts')
  fs.writeFileSync(entry, code)
  const out = path.join(tmp, 'out-' + rows.length)
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      outDir: out,
      emptyOutDir: true,
      target: 'es2022',
      minify: true,
      lib: { entry, formats: ['es'], fileName: 'lite' },
      rollupOptions: { output: { minify: true } },
    },
  })
  // ⚠ 匹配 `.js` **和** `.mjs`：产物扩展名由构建器决定（现在吐 `lite.mjs`）。
  // 只写 `.endsWith('.js')` 时 `find` 返回 `undefined`，下一行 `path.join(undefined)`
  // 直接 `ERR_INVALID_ARG_TYPE` —— 症状是"量体积的脚本崩了"，看着像体积出了问题，
  // 其实只是没找到文件。
  const built = fs.readdirSync(out).find((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  if (!built) throw new Error(`构建没有产出 js/mjs：${out} 里只有 ${fs.readdirSync(out).join(', ')}`)
  const file = path.join(out, built)
  const buf = fs.readFileSync(file)
  rows.push([name, buf.length, gzipSync(buf, { level: 6 }).length])
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0)))
console.log('lite 运行时（生产构建 + gzip；对照：Vue Vapor 运行时地板 ≈ 16 KB gzip，Solid 运行时 ≈ 7 KB）\n')
console.log(pad('裁剪', 40) + 'raw'.padStart(9) + 'gzip'.padStart(9) + '  对比 Solid 的 7KB')
let min = Infinity
for (const [name, raw, gz] of rows) {
  min = Math.min(min, gz)
  console.log(pad(name, 40) + String(raw).padStart(9) + String(gz).padStart(9) + '  ' + (gz < 7168 ? '✓ 小于' : '✗ 大于'))
}
console.log(`\n最小 ${min} B gzip = ${(min / 1024).toFixed(2)} KB`)

/**
 * 第二段：**典型页面端到端**。
 *
 * 第一段量的是"`src/index.ts` 的全部导出都用上"的**上界**；可用户真正下载的是
 * "运行时的**一个子集** + 编译器产物 + 页面代码"。只有这一档能回答"**使用时摇树省了多少**"，
 * 也只有它能把"加一个原语（如 `computed`）到底多花多少"量出来 —— 差值就是那一档的边际代价。
 *
 * ⚠ 跑的是 `dist/vite.js`（`npm run build` 的产物）⇒ `npm run size` 会先 build 一次
 *（见 `package.json`），否则量的是**上一次构建的编译器**。
 * ⚠ 模板串里的 `${…}` 必须写成 `\${…}`：这是 JS 模板串，不转义会被**这里**插值掉 ✗。
 */
/**
 * ⚠ 这几档是**累加**的（后一档 = 前一档 + 那一件事），否则 Δ 只是"两个无关页面谁大" ✗。
 * 所以每档只加**那一件事**要用的代码，别顺手改别的行。
 */
const pages = {
  '① 最小页：ref + 文本 + 事件': `
import { mount, ref } from '${src('index.ts')}'
const n = ref(0)
const App = () => <button onClick={() => n.value++}>点了 {n.value} 次</button>
mount(App, '#app')`,
  '② + 条件分支': `
import { mount, ref } from '${src('index.ts')}'
const n = ref(0)
const on = ref(true)
const App = () => <button onClick={() => n.value++}>{on.value ? <>点了 {n.value} 次</> : null}</button>
mount(App, '#app')`,
  '③ + keyed 列表（createFor）': `
import { mount, ref } from '${src('index.ts')}'
const n = ref(0)
const on = ref(true)
const items = ref([{ id: 1, text: 'a' }])
const App = () => (
  <div>
    <button onClick={() => n.value++}>{on.value ? <>点了 {n.value} 次</> : null}</button>
    <ul>{items.value.map((it) => <li key={it.id}>{it.text}</li>)}</ul>
  </div>
)
mount(App, '#app')`,
  '④ + computed': `
import { computed, mount, ref } from '${src('index.ts')}'
const n = ref(0)
const on = ref(true)
const items = ref([{ id: 1, text: 'a' }])
const double = computed(() => n.value * 2)
const App = () => (
  <div>
    <button onClick={() => n.value++}>{on.value ? <>点了 {n.value} 次 / {double.value}</> : null}</button>
    <ul>{items.value.map((it) => <li key={it.id}>{it.text}</li>)}</ul>
  </div>
)
mount(App, '#app')`,
  '⑤ + watch': `
import { computed, mount, ref, watch } from '${src('index.ts')}'
const n = ref(0)
const on = ref(true)
const items = ref([{ id: 1, text: 'a' }])
const double = computed(() => n.value * 2)
watch(n, (v) => console.log(v))
const App = () => (
  <div>
    <button onClick={() => n.value++}>{on.value ? <>点了 {n.value} 次 / {double.value}</> : null}</button>
    <ul>{items.value.map((it) => <li key={it.id}>{it.text}</li>)}</ul>
  </div>
)
mount(App, '#app')`,
  '⑥ + 组件 + 插槽': `
import { computed, mount, ref, useSlots, watch } from '${src('index.ts')}'
const n = ref(0)
const on = ref(true)
const items = ref([{ id: 1, text: 'a' }])
const double = computed(() => n.value * 2)
watch(n, (v) => console.log(v))
const Box = () => <section>{useSlots().default?.()}</section>
const App = () => (
  <div>
    <button onClick={() => n.value++}>{on.value ? <>点了 {n.value} 次 / {double.value}</> : null}</button>
    <Box><ul>{items.value.map((it) => <li key={it.id}>{it.text}</li>)}</ul></Box>
  </div>
)
mount(App, '#app')`,
  '⑦ + untrack': `
import { computed, mount, ref, untrack, useSlots, watch } from '${src('index.ts')}'
const n = ref(0)
const on = ref(true)
const items = ref([{ id: 1, text: 'a' }])
const double = computed(() => n.value * 2)
watch(n, (v) => console.log(v))
const Box = () => <section>{useSlots().default?.()}</section>
const App = () => (
  <div>
    <button onClick={() => n.value++}>{on.value ? <>点了 {n.value} 次 / {double.value} / {untrack(() => n.value)}</> : null}</button>
    <Box><ul>{items.value.map((it) => <li key={it.id}>{it.text}</li>)}</ul></Box>
  </div>
)
mount(App, '#app')`,
}

/** 用插件（= 消费方那套）编译真 TSX，再打包量体积。 */
const { default: lite } = await import('./dist/vite.js')
const pageRows = []
let i = 0
for (const [name, body] of Object.entries(pages)) {
  const entry = path.join(tmp, `page${i}.tsx`)
  fs.writeFileSync(entry, body.trim() + '\n')
  const out = path.join(tmp, 'page-out-' + i)
  await build({
    configFile: false,
    logLevel: 'error',
    plugins: [lite({ runtime: src('index.ts') })],
    build: {
      outDir: out,
      emptyOutDir: true,
      target: 'es2022',
      minify: true,
      lib: { entry, formats: ['es'], fileName: 'page' },
      rollupOptions: { output: { minify: true } },
    },
  })
  const built = fs.readdirSync(out).find((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  const buf = fs.readFileSync(path.join(out, built))
  pageRows.push([name, buf.length, gzipSync(buf, { level: 6 }).length])
  i++
}

console.log('\n典型页面端到端（运行时子集 + 编译器产物 + 页面代码；Δ = 相对上一档的边际代价）\n')
console.log(pad('页面', 34) + 'raw'.padStart(9) + 'gzip'.padStart(9) + '      Δ gzip')
let prev = null
for (const [name, raw, gz] of pageRows) {
  const d = prev === null ? '—' : `${gz - prev >= 0 ? '+' : ''}${gz - prev} B`
  console.log(pad(name, 34) + String(raw).padStart(9) + String(gz).padStart(9) + '   ' + d.padStart(8))
  prev = gz
}

fs.rmSync(tmp, { recursive: true, force: true })
