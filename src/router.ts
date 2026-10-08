/**
 * 路径路由 —— **干净 URL，不用 `#`**。可选件：不用它整段被摇掉。
 *
 * # 为什么它在这里，而不在各个应用里
 *
 * 同一个组织下有两个应用需要它。真正的价值不在"能跳转"，而在下面这些**踩过才知道、
 * 且写错不报错**的地方 —— 这些知识放在应用里就是抄第二遍：
 *
 * 1. `pushState` **不会**触发 `popstate`（浏览器只在"用户真的导航"时发它）。所以改完地址
 *    要自己同步一次，才能让"前进/后退、手敲地址、点按钮"落到**同一条**切页路径上。
 *    少了这步的症状很好认：点导航按钮**页面不动**，但按一下浏览器后退却动了。
 * 2. 已经在该地址上就别再 `pushState`：否则用户按后退会"原地不动"一次 —— 那是历史栈被
 *    污染，不是他点错了。
 * 3. 地址是**单一真源**：别在别处再存一份"当前页"，两份迟早分叉。
 *
 * # 为什么由它来渲染页面，而不是把"路由表 → 组件"交给调用方
 *
 * 直觉写法是调用方自己查表：`{VIEWS[name]}` 或 `{ok ? C : D}`。**这两种都会静默编错** ——
 * 编译器按**语法**识别组件（首字母大写 / 带点），把组件**当值**传给 `setNodes` 时
 * **不会**生成 `createComponent`，产物里那个位置就成了一坨普通值。编得过、跑起来不对。
 * 唯一可靠的写法是把组件写成 JSX 字面量（`<C/>`），于是声明式查表只能退化成随路由数
 * 增长的三元链。
 *
 * ⇒ 那就让 `view()` 把 `createComponent` 这一步收进来：调用方写 `{router.view()}` 一行，
 * 不管有多少条路由。组件收到的 props 是 `{ route }`。
 *
 * # 同步，不推微任务（**实测结论**，与旧文档相反）
 *
 * 旧文档曾写"跨视图跳转必须推到下一个任务（`queueMicrotask`）"，理由是同步换页会让新页
 * 被无限重建。**实测复现不出来**：`demo/main.tsx` 的 EXP 段跑了 8 种组合（声明式/命令式
 * 切页 × 触发点在子树内/外壳 × 挂载期写信号/不写 × 挂载期重定向/不重定向 × 同步/微任务），
 * 全部是"每页各建一次、节点不累积"。
 *
 * 原因是运行期**后来加了守卫**（`dom.ts` 里 `setNodes` 的"陈旧 effect 自毁"、以及
 * `lazySlot` 的占位绑定）—— 旧文档描述的是加守卫**之前**的行为。
 *
 * 所以这里**同步**：与 `signal.ts` 的既有原则一致（"同步 + 批量，不做微任务调度队列"），
 * 且 `navigate()` 返回时状态**已经**变了，调用方不必猜。
 *
 * ⚠ 这是**实测结论，不是不变量**。若又见到"新页无限重建/节点累积"，先按
 * `docs/pitfalls.md` 的三步排查，再考虑在调用处自行包一层 `queueMicrotask` ——
 * 别改这里，那会把"框架保证同步"这件事悄悄推翻。
 *
 * # 与静态文件回落的相互作用（服务端的事，但会咬到这里）
 *
 * SPA 回落通常把"认不出、且**末段带点**"的路径当静态资源发（有意为之：防发版后旧
 * `index.html` 去要已不存在的旧 chunk）⇒ **路由段里不能出现 `.`**。新增路由时要过一遍，
 * 本库管不了。
 *
 * # 有意不做
 *
 * 嵌套路由（父子 outlet 那种）、`base`/子路径挂载（挂到 `/app/` 下要动 `index.html` 的
 * `<base>`，属应用与服务端的约定）、导航守卫、滚动恢复。按"真实项目里到底用了什么"收录。
 * （**前缀模式 `*` 不算"通配符"这一档**：它是"一页拥有整片地址"的表达，两个使用方都要。）
 *
 * **按页懒加载 chunk 也不做**（`views` 是急切的，构造时组件都已在）。原因：那需要引入
 * "加载中 / 加载失败"两种状态与竞态处理，**属应用策略**（哪几个 chunk、转圈长什么样、
 * 失败怎么提示），不是路由该替调用方决定的。在产项目的做法是：自己存一个
 * `() => unknown` 的渲染闭包 + 按页缓存，`route` 只当"该渲染哪个"的输入 —— 这与
 * `view()` 内部做的事一样，只是多了异步那一层。
 */

import { createComponent, type Component } from './component'
import { ref, type ReadonlyRef } from './signal'

/**
 * 从路径模板里抽出参数名：`'/tasks/:id'` → `'id'`，`'/:a/:b'` → `'a' | 'b'`。
 * 一个路由名拥有多个模式时取**并集**。
 *
 * 用途只有一个：让 `href` / `navigate` 的**参数名写错时在编译期就报**，而不是等用户
 * 点下去才发现地址少了一截。运行时仍会再查一次（见 `href`）。
 */
export type RouteParams<P> = P extends string
  ? P extends `${string}:${infer Tail}`
    ? Tail extends `${infer K}/${infer R}`
      ? K | RouteParams<`/${R}`>
      : Tail
    : never
  : P extends readonly (infer S)[]
    ? S extends string
      ? RouteParams<S>
      : never
    : never

/**
 * 调用方要传的参数：**路由参数必填，多出来的键自动拼成 query**。
 *
 * `Record<never, string>` 就是 `{}`，所以无参数的路由退化成"随便传"，不必特判。
 */
export type RouteArgs<P> = Record<RouteParams<P>, string> & Partial<Record<string, string>>

/** 一次匹配的结果。`name` 是路由名；匹配不到时是 `fallback` 指定的那个。 */
export interface RouteLocation<K extends string = string> {
  name: K
  /** 实际路径（`location.pathname`）。 */
  path: string
  params: Record<string, string>
  query: Record<string, string>
}

/** 页面组件收到的 props。只有一个字段，免得和调用方自己的 props 撞名。 */
export interface RouteProps<K extends string = string> {
  route: RouteLocation<K>
}

/** 一个路由名对应的地址模式：单个字符串，或**多个**（第一个是 `href` 用的规范地址）。 */
export type RoutePatterns = string | readonly string[]

export interface RouterOptions<R extends Record<string, RoutePatterns>> {
  /**
   * 路由名 → 地址模式。模板段以 `:` 开头的是参数（`/tasks/:id`）。
   *
   * 一个名字可以拥有**多个**模式，第一个是 `href` 生成的规范地址、其余是"也归它"：
   *
   * ```ts
   * routes: {
   *   tasks: ['/tasks', '/tasks/:name/config'],
   *   settings: ['/settings', '/settings/*'],   // 前缀：整片地址都归这一页
   *   history: ['/history', '/logs'],           // 老地址照旧打得开
   * }
   * ```
   *
   * 末段是 `*` 的是**前缀模式**：匹配"这个前缀本身 + 它下面的任意深度"（`/settings/*`
   * 命中 `/settings`、`/settings/security`、`/settings/a/b/c`），剩余部分进 `params['*']`。
   * 子视图深度**数据驱动**时（`/accounts/<id>/<tab>/<sub>`）必须用它 —— 枚举深度必然漏，
   * 而漏掉的表现是**静默落到兜底页**（地址对、界面却是另一页）。
   *
   * 为什么要这个：一页常常**不止一个地址**（子视图、改名后要兼容的老地址）。
   * 没有它就只能把子视图拆成另一个路由名，于是 `route.name` 不再等于页面 id，
   * 调用方得多写一层映射 —— 而那层映射正是这里想省掉的。
   *
   * **按声明顺序匹配，先命中者胜** —— 把更具体的放前面（`/tasks/config` 要排在
   * `/tasks/:name` 之前，否则 `config` 会被当成任务名）。
   */
  routes: R
  /** 匹配不到时用哪个路由名。必须是 `routes` 的键。 */
  fallback: keyof R & string
  /**
   * 路由名 → 页面组件。给了它才能用 `view()`。
   * **必须覆盖 `routes` 里的每一个名字**（含 `fallback`）—— 构造时校验，不留到渲染时才炸。
   */
  views?: { [K in keyof R]: Component<RouteProps<K & string>> }
}

export interface Router<R extends Record<string, RoutePatterns>> {
  /** 当前位置。**只读**：它是地址的副本，写它不会改地址（单一真源是 `location`）。 */
  readonly route: ReadonlyRef<RouteLocation<keyof R & string>>
  /** 跳到某个路由。已在目标地址上时**什么都不做**（不污染历史栈）。 */
  navigate<K extends keyof R & string>(name: K, args?: RouteArgs<R[K]>, opts?: { replace?: boolean }): void
  /**
   * 生成链接。路由参数填 `:名字`，**剩下的键拼成 query**。
   * 一个路由名有多个模式时，由**参数**决定用哪个（挑第一个参数给齐的）——
   * 所以 `href('tasks')` 得 `/tasks`、`href('tasks', { name })` 得 `/tasks/<name>/config`。
   */
  href<K extends keyof R & string>(name: K, args?: RouteArgs<R[K]>): string
  /**
   * 跳到任意应用内路径。已在目标地址上时**什么都不做**（不污染历史栈）。
   *
   * 什么时候用它是合理的：**手里是路径、不是路由名** —— 子视图（`/tasks/config`）常是
   * 字面量，而它可能与 `:参数` 模式同形，靠 `href` 生成反而别扭。
   * ⚠ 能用 `navigate(名字, 参数)` 就别用它：名字写错编译期就报，路径写错要到点下去才发现。
   */
  push(path: string, opts?: { replace?: boolean }): void
  /**
   * 当前路由对应的页面节点。用法：`{router.view()}`。
   * ⚠ 必须写在**动态子节点位置**（也就是 `{…}` 里）；写成静态子节点会静默不生效。
   * ⚠ `views` 是**急切**的：组件在构造时就都已加载。要按页懒加载 chunk，见文件头"有意不做"。
   */
  view(): unknown
  /** 摘掉 `popstate` 监听。测试与热替换用。 */
  dispose(): void
}

/** 模板编译结果：正则 + 参数名（按出现顺序，与捕获组一一对应）。 */
interface Compiled {
  re: RegExp
  keys: string[]
}

/** 把 `string | string[]` 统一成数组。 */
function toPatterns(v: RoutePatterns): readonly string[] {
  return typeof v === 'string' ? [v] : v
}

/**
 * 把 `/tasks/:id` 编成 `^/tasks/([^/]+)$`；末段是 `*` 的编成**前缀模式**。
 *
 * 静态段要**转义正则元字符**：路径里出现 `.` `+` `(` 之类并不罕见（`/a.b`），不转义就会
 * 变成通配、匹配到别的路径上，而且只在特定路径下才现形。
 *
 * `*` 只能是**末段**，表示"这一页拥有这个前缀下的**任意深度**"：`/settings/*` 匹配
 * `/settings` 与 `/settings/security`、`/settings/a/b/c`。捕获到的剩余部分放在 `params['*']`。
 *
 * 为什么必须有它（而不是让调用方把深度枚举出来）：一页的子视图深度常是**数据驱动**的
 * （`/accounts/<id>/<tab>/<sub>`），枚举必然漏；而"首段归属"这种规则本来就是这个意思。
 * 实测教训：只给显式模式时，漏掉的深度会**静默落到兜底页** —— 地址对、界面却是另一页。
 */
function compile(pattern: string): Compiled {
  const segs = pattern.split('/')
  const isPrefix = segs.length > 1 && segs[segs.length - 1] === '*'
  const keys: string[] = []
  const body = (isPrefix ? segs.slice(0, -1) : segs)
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1))
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  if (!isPrefix) return { re: new RegExp(`^${body}$`), keys }
  // `(?:/(.*))?` 让"前缀本身"也算命中：`/settings/*` 要匹配 `/settings`，不只是 `/settings/x`
  return { re: new RegExp(`^${body}(?:/(.*))?$`), keys: [...keys, '*'] }
}

/**
 * 解一个 URL 片段，**失败不抛**。
 *
 * `decodeURIComponent('%')` 会抛 `URIError`。地址栏里的是**外部输入**（手敲、别处贴过来），
 * 为一个坏百分号把整个路由打挂不值得 ⇒ 解不开就原样返回。
 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 模式里 `:param` 的名字，按出现顺序。 */
function paramNames(pattern: string): string[] {
  return pattern
    .split('/')
    .filter((s) => s.startsWith(':'))
    .map((s) => s.slice(1))
}

export function createRouter<R extends Record<string, RoutePatterns>>(opts: RouterOptions<R>): Router<R> {
  const routes = opts.routes
  const names = Object.keys(routes) as (keyof R & string)[]
  const compiled = new Map<string, Compiled[]>()
  for (const n of names) compiled.set(n, toPatterns(routes[n]).map(compile))

  const views = opts.views
  if (views) {
    // 构造时一次校验完：漏配的页面是**写错了**，不该等到用户点进那页才发现空白
    const missing = names.filter((n) => !views[n])
    if (missing.length) throw new Error(`router: 这些路由没有配页面组件 —— ${missing.join('、')}`)
  }

  /** 把地址解成一次匹配。匹配不到 ⇒ `fallback`，params 为空。 */
  function parse(pathname: string, search: string): RouteLocation<keyof R & string> {
    const query: Record<string, string> = {}
    // `URLSearchParams` 自己处理重复键；同名取**第一个**（够用，且比"最后一个"更可预测）
    new URLSearchParams(search).forEach((v, k) => {
      if (!(k in query)) query[k] = v
    })
    for (const name of names) {
      // 一个名字可能拥有多个模式（子视图、老地址）；按声明顺序试，先命中者胜
      for (const c of compiled.get(name)!) {
        const m = c.re.exec(pathname)
        if (!m) continue
        const params: Record<string, string> = {}
        for (let i = 0; i < c.keys.length; i++) {
          // 前缀模式的 `*` 在前缀本身命中时**没有捕获值**（`/settings` 匹配 `/settings/*`）
          params[c.keys[i]] = m[i + 1] === undefined ? '' : safeDecode(m[i + 1])
        }
        return { name, path: pathname, params, query }
      }
    }
    return { name: opts.fallback, path: pathname, params: {}, query }
  }

  const route = ref<RouteLocation<keyof R & string>>(parse(location.pathname, location.search))

  function href<K extends keyof R & string>(name: K, args?: RouteArgs<R[K]>): string {
    const pats = routes[name]
    // 拼一个不存在的路由名是**写错了**：地址栏会变成死链接，而问题要到用户点下去才现形
    if (pats === undefined) throw new Error(`router: 没有名为 "${name}" 的路由`)
    const list = toPatterns(pats)
    const bag = (args ?? {}) as Record<string, string>

    /**
     * 生成链接**优先用非前缀模式**：前缀模式（`/settings/*`）是给"匹配"用的 —— 它表达的
     * 是一整片地址，具体生成哪一个无从下手。只有整个路由都是前缀模式时才退而用它
     * （此时把末段的 `*` 丢掉，得到前缀本身）。
     */
    const plain = list.filter((p) => !p.endsWith('*'))
    const pool = plain.length ? plain : list

    /**
     * **参数决定用哪个模式**：在"它要的参数都给齐了"的那些里挑**参数最多**的（更具体的
     * 优先），并列时按声明顺序。
     *
     * 于是 `href('tasks')` → `/tasks`，而 `href('tasks', { name })` → `/tasks/<name>/config`
     * —— 调用方不必记住"第几个模式是详情页"，也不会因为模式顺序调整而悄悄生成错链接。
     *
     * ⚠ 判据必须是"参数最多"而不是"第一个合格的"：无参数的模式（`/tasks`）**永远合格**，
     * 按顺序取就永远轮不到带参数的那个。
     */
    let chosen = pool[0]
    let best = -1
    for (const p of pool) {
      const keys = paramNames(p)
      if (!keys.every((k) => bag[k] !== undefined)) continue
      if (keys.length > best) {
        best = keys.length
        chosen = p
      }
    }

    const used = new Set<string>()
    const segs = chosen.split('/')
    // 末段的 `*` 是"任意深度"的占位，生成链接时丢掉（得到前缀本身）
    if (segs[segs.length - 1] === '*') segs.pop()
    const path = segs
      .map((seg) => {
        if (!seg.startsWith(':')) return seg
        const k = seg.slice(1)
        const v = bag[k]
        if (v === undefined) throw new Error(`router: 路由 "${name}" 缺少参数 "${k}"`)
        used.add(k)
        return encodeURIComponent(v)
      })
      .join('/')

    // 剩下的键拼成 query：省得调用方自己拼串、自己记得编码
    const rest = new URLSearchParams()
    for (const k in bag) if (!used.has(k)) rest.append(k, bag[k])
    const q = rest.toString()
    return q ? `${path}?${q}` : path
  }

  function push(path: string, o?: { replace?: boolean }): void {
    // 已在目标上就别动历史栈（见文件头第 2 条）
    if (location.pathname + location.search === path) return
    if (o?.replace) history.replaceState(null, '', path)
    else history.pushState(null, '', path)
    // ⚠ `pushState` / `replaceState` **都不发** `popstate`，必须自己同步一次，
    // 否则"点按钮"与"按后退"会走两条不同的路径（见文件头第 1 条）
    sync()
  }

  function navigate<K extends keyof R & string>(
    name: K,
    args?: RouteArgs<R[K]>,
    o?: { replace?: boolean },
  ): void {
    push(href(name, args), o)
  }

  function sync(): void {
    route.value = parse(location.pathname, location.search)
  }

  function view(): unknown {
    if (!views) throw new Error('router: 没有传 views，view() 不可用（只用匹配/导航就别调它）')
    const loc = route.value
    // 类型上 `views` 覆盖了全部路由名，所以这里取得到；`??` 只为让类型收窄
    const C = views[loc.name] ?? views[opts.fallback]
    return createComponent(C as Component<RouteProps>, { route: loc })
  }

  const onPop = (): void => sync()
  window.addEventListener('popstate', onPop)

  return { route, navigate, href, push, view, dispose: () => window.removeEventListener('popstate', onPop) }
}
