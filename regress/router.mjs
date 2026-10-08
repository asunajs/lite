/**
 * 路由门禁：匹配、参数、query、`href` 拼装、历史栈行为、构造期校验。
 *
 * 为什么在 Node 里跑而不是浏览器：判据几乎都是**纯函数**（路径进、匹配出），只有
 * `location` / `history` / `popstate` 三个接触面，桩掉它们就能全测掉。放进 `npm run gates`
 * ⇒ **CI 每次都会跑到**（`demo` 那套要无头 Chrome 且故意不进 CI，见 `AGENTS.md`）。
 * 真 DOM 的部分留给 `demo/main.tsx`。
 *
 * 用法：`npm run test:router`（退出码非 0 = 有用例不符合预期）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = path.dirname(new URL(import.meta.url).pathname)
const root = path.join(dir, '..')
const tmp = path.join(dir, '.check-router-tmp')

// ── DOM 桩 ───────────────────────────────────────────────────────────────────
// 只桩路由真正碰到的那几样。桩得越少，测出来的东西越接近真的。
let url = '/'
const popListeners = new Set()
const historyCalls = []

globalThis.location = {
  get pathname() {
    return url.split('?')[0]
  },
  get search() {
    const i = url.indexOf('?')
    return i < 0 ? '' : url.slice(i)
  },
}
globalThis.window = {
  addEventListener: (t, f) => {
    if (t === 'popstate') popListeners.add(f)
  },
  removeEventListener: (t, f) => {
    if (t === 'popstate') popListeners.delete(f)
  },
}
globalThis.history = {
  pushState: (_s, _t, u) => {
    historyCalls.push(['push', u])
    url = u
  },
  replaceState: (_s, _t, u) => {
    historyCalls.push(['replace', u])
    url = u
  },
}

/** 模拟"用户按了后退"：浏览器改完地址后发 `popstate`。 */
const firePop = (to) => {
  url = to
  for (const f of popListeners) f()
}

// ── 构建被测模块 ─────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
fs.writeFileSync(
  path.join(tmp, 'entry.ts'),
  // vite 的 lib 入口不能是仓库外的虚拟模块，那就写一个一行的转发。
  // ⚠ 临时目录是 `regress/.check-router-tmp`，所以 `../../` 才回到仓库根
  `export { createRouter } from '../../src/router.ts'\n`,
)
try {
  execFileSync('npx', ['vite', 'build', '--config', path.join(dir, 'check-router.vite.config.ts')], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  })
} catch (e) {
  console.log('✗ 临时构建失败：\n' + [String(e.stdout ?? ''), String(e.stderr ?? '')].join('\n').split('\n').slice(-14).join('\n'))
  process.exit(1)
}
const outFile = path.join(tmp, 'out', 'router.js')
const { createRouter } = await import(pathToFileURL(outFile).href)

// ── 用例 ─────────────────────────────────────────────────────────────────────
const ROUTES = {
  dashboard: '/',
  tasks: '/tasks',
  'task-detail': '/tasks/:id',
  runs: '/runs',
  dotted: '/a.b',
}
const Page = () => null

/** 每个用例一个干净的路由器（并摘掉上一个的监听，免得住状态互相污染）。 */
let live = null
const fresh = (path = '/', extra = {}) => {
  live?.dispose()
  url = path
  historyCalls.length = 0
  live = createRouter({ routes: ROUTES, fallback: 'dashboard', views: Object.fromEntries(Object.keys(ROUTES).map((k) => [k, Page])), ...extra })
  return live
}

let bad = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) console.log(`  ✅ ${name}`)
  else {
    bad++
    console.log(`  ✗ ${name}\n      得到 ${g}\n      期望 ${w}`)
  }
}
const throws = (name, fn, frag) => {
  try {
    fn()
    bad++
    console.log(`  ✗ ${name} —— 本该抛错却通过了`)
  } catch (e) {
    const m = String(e.message)
    if (frag && !m.includes(frag)) {
      bad++
      console.log(`  ✗ ${name} —— 抛了，但信息里没有「${frag}」：${m}`)
    } else console.log(`  ✅ ${name}`)
  }
}

console.log('\n匹配与解析')
{
  const r = fresh('/')
  eq('根路径命中 dashboard', r.route.value.name, 'dashboard')
  eq('根路径无参数', r.route.value.params, {})
}
{
  const r = fresh('/tasks/42')
  eq('参数路由命中', r.route.value.name, 'task-detail')
  eq('参数被抽出', r.route.value.params, { id: '42' })
}
{
  const r = fresh('/tasks/%E4%B8%AD%E6%96%87')
  eq('参数按百分号解码', r.route.value.params, { id: '中文' })
}
{
  const r = fresh('/tasks/%E4%B8')
  eq('坏百分号不抛、原样保留', r.route.value.params, { id: '%E4%B8' })
}
{
  const r = fresh('/runs?task=a&task=b&q=1')
  eq('query 同名取第一个', r.route.value.query, { task: 'a', q: '1' })
}
{
  const r = fresh('/nope/deep')
  eq('未匹配落到 fallback', r.route.value.name, 'dashboard')
  eq('fallback 时 params 为空', r.route.value.params, {})
  eq('fallback 时 path 仍是真实地址', r.route.value.path, '/nope/deep')
}
{
  // 静态段里的 `.` 必须被转义，否则 `/a.b` 会变成"a 任意 b"，把 /axb 也吃掉
  const r = fresh('/axb')
  eq('静态段的 `.` 不当日通配（/axb 不该命中 /a.b）', r.route.value.name, 'dashboard')
  const r2 = fresh('/a.b')
  eq('静态段的 `.` 精确匹配', r2.route.value.name, 'dotted')
}

console.log('\nhref 拼装')
{
  const r = fresh()
  eq('无参数路由', r.href('tasks'), '/tasks')
  eq('参数替换', r.href('task-detail', { id: '42' }), '/tasks/42')
  eq('参数编码', r.href('task-detail', { id: 'a/b c' }), '/tasks/a%2Fb%20c')
  eq('多余的键拼成 query', r.href('task-detail', { id: '1', tab: 'log' }), '/tasks/1?tab=log')
  eq('无参数路由也能带 query', r.href('tasks', { q: 'x y' }), '/tasks?q=x+y')
  throws('未知路由名抛错', () => r.href('nope'), '没有名为 "nope" 的路由')
  throws('缺参数抛错', () => r.href('task-detail'), '缺少参数 "id"')
}

console.log('\n导航与历史栈')
{
  const r = fresh('/')
  r.navigate('tasks')
  eq('navigate 走 pushState', historyCalls, [['push', '/tasks']])
  eq('navigate 后 route 立刻更新（同步）', r.route.value.name, 'tasks')
}
{
  const r = fresh('/tasks')
  r.navigate('tasks')
  eq('已在目标地址上 ⇒ 不动历史栈', historyCalls, [])
}
{
  const r = fresh('/')
  r.navigate('tasks', undefined, { replace: true })
  eq('replace 走 replaceState', historyCalls, [['replace', '/tasks']])
}
{
  const r = fresh('/tasks/1')
  r.navigate('task-detail', { id: '2' })
  eq('换参数 = 换地址', r.route.value.params, { id: '2' })
}
{
  const r = fresh('/')
  firePop('/tasks/9')
  eq('popstate 后 route 跟着变', [r.route.value.name, r.route.value.params.id], ['task-detail', '9'])
}
{
  const r = fresh('/')
  r.dispose()
  const n = popListeners.size
  firePop('/runs')
  eq('dispose 后不再响应 popstate', [n, r.route.value.name], [0, 'dashboard'])
}

console.log('\n构造期校验')
{
  const r = fresh('/')
  eq('每个路由都能取到页面节点', typeof r.view(), 'object')
  r.dispose()
}
throws(
  '漏配页面组件 ⇒ 构造时就抛',
  () => createRouter({ routes: { a: '/a', b: '/b' }, fallback: 'a', views: { a: Page } }),
  '没有配页面组件',
)
throws(
  'view() 但没传 views ⇒ 明确报错',
  () => {
    const r = createRouter({ routes: { a: '/a' }, fallback: 'a' })
    try {
      r.view()
    } finally {
      r.dispose()
    }
  },
  '没有传 views',
)

live?.dispose()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? `\n✗ ${bad} 条不符合预期` : '\n✓ 路由用例全部符合预期')
process.exitCode = bad ? 1 : 0
