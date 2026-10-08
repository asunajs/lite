# AGENTS.md —— 在 lite 仓库里干活

lite 是一个**独立库**（不是某个应用的附庸）。注释与文档一律按"**陌生人第一次读**"来写：

* **留机理**：为什么必须是 `WeakMap`、锚点为什么用 `<!---->`、"看着像 bug 但故意的"那些、
  静默失败模式、与 Solid / Vapor 的取舍。
* **删叙事**：日期、"用户报…"/"真机上报"、使用方的页面与组件名、内部文档编号引用、
  "本仓/本项目"口气、同一件事讲三遍。
* 引用别的文档**按主题名**（如 `docs/pitfalls.md`「锚点：动态子节点为什么会错位」），
  **不要写 `§编号`** —— 重排一次就失效。

## 命令

```bash
npm run gates            # typecheck + build + 编译期负例（纯 Node，CI 跑的就是它）
LITE_CHROME_NO_SANDBOX=1 npm run test:demo    # 真 DOM 验收（要无头 Chrome）
LITE_CHROME_NO_SANDBOX=1 npm run test:bench   # 产物行为断言 + 耗时护栏
npm run size             # 量运行时体积（生产构建 + gzip）
```

⚠ `test:demo` / `test:bench` **故意不进 CI**（要装几十 MB 的无头 Chrome）：**谁改谁本地跑**。
没装浏览器的机器上它们**会直接失败**（不印"跳过"、不冒充绿）⇒ 别把"CI 绿"当成"验过"。

## 硬规则

* **不要加 `typescript` / `tsc`**：类型检查用 `tsgo`（`@typescript/native-preview`）。
* **`dist/` 入库**：改完源码**必须** `npm run build` 并把 `dist/` 一起提交 ——
  git 依赖装完即用靠的就是它，CI 的「`dist` 与源码同步」一步会拦下漂移。
* **运行时不能预编译**：`src/dev.ts` 靠 `import.meta.env.DEV` 在**使用方**的构建里被静态替换；
  在这里先编译一遍，那句就变成字面量 `false`。
* `oxc-parser` 是**原生**包（napi）⇒ 凡把它打进 Node 侧产物的构建都要标 `external`。
* 只有具名导出；文件名 kebab-case；中文注释、说清**为什么**。

## 文档分工（别写串）

| 文件 | 给谁 |
|---|---|
| `README.md` | 路过的人：这是什么、怎么装、30 秒上手 |
| `docs/agent.md` | **在别的项目里用 lite** 的 agent / 人：硬约束 + 静默坑（一屏） |
| `docs/guide.md` | 要用这个库的人：教程、语法子集、常见坑、API |
| `docs/design.md` | 要**改**这个库的人：设计与取舍、体积/性能、门禁、"不做"清单 |
| `docs/pitfalls.md` | 已经踩到坑的人：按症状分节（现象 → 根因 → 现在怎么防） |
