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
 * 嵌套路由、通配符、`base`/子路径挂载（挂到 `/app/` 下要动 `index.html` 的 `<base>`，
 * 属应用与服务端的约定）、懒加载、导航守卫、滚动恢复。按"真实项目里到底用了什么"收录，
 * 以上都还没有第二个使用方。
 */

import { createComponent, type Component } from './component'
import { ref, type ReadonlyRef } from './signal'

/**
 * 从路径模板里抽出参数名：`'/tasks/:id'` → `'id'`，`'/:a/:b'` → `'a' | 'b'`。
 *
 * 用途只有一个：让 `href` / `navigate` 的**参数名写错时在编译期就报**，而不是等用户
 * 点下去才发现地址少了一截。运行时仍会再查一次（见 `href`）。
 */
export type RouteParams<P extends string> = P extends `${string}:${infer Tail}`
  ? Tail extends `${infer K}/${infer R}`
    ? K | RouteParams<`/${R}`>
    : Tail
  : never

/**
 * 调用方要传的参数：**路由参数必填，多出来的键自动拼成 query**。
 *
 * `Record<never, string>` 就是 `{}`，所以无参数的路由退化成"随便传"，不必特判。
 */
export type RouteArgs<P extends string> = Record<RouteParams<P>, string> & Partial<Record<string, string>>

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

export interface RouterOptions<R extends Record<string, string>> {
  /**
   * 路由名 → 路径模板。模板段以 `:` 开头的是参数（`/tasks/:id`）。
   * **按声明顺序匹配，先命中者胜** —— 把更具体的放前面。
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

export interface Router<R extends Record<string, string>> {
  /** 当前位置。**只读**：它是地址的副本，写它不会改地址（单一真源是 `location`）。 */
  readonly route: ReadonlyRef<RouteLocation<keyof R & string>>
  /** 跳到某个路由。已在目标地址上时**什么都不做**（不污染历史栈）。 */
  navigate<K extends keyof R & string>(name: K, args?: RouteArgs<R[K]>, opts?: { replace?: boolean }): void
  /** 生成链接。路由参数填 `:名字`，**剩下的键拼成 query**。 */
  href<K extends keyof R & string>(name: K, args?: RouteArgs<R[K]>): string
  /**
   * 当前路由对应的页面节点。用法：`{router.view()}`。
   * ⚠ 必须写在**动态子节点位置**（也就是 `{…}` 里）；写成静态子节点会静默不生效。
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

/**
 * 把 `/tasks/:id` 编成 `^/tasks/([^/]+)$`。
 *
 * 静态段要**转义正则元字符**：路径里出现 `.` `+` `(` 之类并不罕见（`/a.b`），不转义就会
 * 变成通配、匹配到别的路径上，而且只在特定路径下才现形。
 */
function compile(pattern: string): Compiled {
  const keys: string[] = []
  const body = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1))
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { re: new RegExp(`^${body}$`), keys }
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

export function createRouter<R extends Record<string, string>>(opts: RouterOptions<R>): Router<R> {
  const routes = opts.routes
  const names = Object.keys(routes) as (keyof R & string)[]
  const compiled = new Map<string, Compiled>()
  for (const n of names) compiled.set(n, compile(routes[n]))

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
      const c = compiled.get(name)!
      const m = c.re.exec(pathname)
      if (!m) continue
      const params: Record<string, string> = {}
      for (let i = 0; i < c.keys.length; i++) params[c.keys[i]] = safeDecode(m[i + 1])
      return { name, path: pathname, params, query }
    }
    return { name: opts.fallback, path: pathname, params: {}, query }
  }

  const route = ref<RouteLocation<keyof R & string>>(parse(location.pathname, location.search))

  function href<K extends keyof R & string>(name: K, args?: RouteArgs<R[K]>): string {
    const pattern = routes[name] as string | undefined
    // 拼一个不存在的路由名是**写错了**：地址栏会变成死链接，而问题要到用户点下去才现形
    if (pattern === undefined) throw new Error(`router: 没有名为 "${name}" 的路由`)

    const bag = (args ?? {}) as Record<string, string>
    const used = new Set<string>()
    const path = pattern
      .split('/')
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

  function navigate<K extends keyof R & string>(
    name: K,
    args?: RouteArgs<R[K]>,
    o?: { replace?: boolean },
  ): void {
    const target = href(name, args)
    // 已在目标上就别动历史栈（见文件头第 2 条）
    if (location.pathname + location.search === target) return
    if (o?.replace) history.replaceState(null, '', target)
    else history.pushState(null, '', target)
    // ⚠ `pushState` / `replaceState` **都不发** `popstate`，必须自己同步一次，
    // 否则"点按钮"与"按后退"会走两条不同的路径（见文件头第 1 条）
    sync()
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

  return { route, navigate, href, view, dispose: () => window.removeEventListener('popstate', onPop) }
}
