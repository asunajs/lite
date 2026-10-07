/**
 * 无头 Chrome 的公共启动参数 —— 这个仓里所有 spawn chrome 的地方都只从这一处取。
 *
 * # 为什么单独一个文件
 *
 * 会 spawn chrome 的有 `demo/run.mjs` 与 `bench/run.mjs`（以后还会加）。参数表一旦分散，
 * "要加什么"就得改好几处，而且会出现"一处加了 `--no-sandbox`、另一处又把它还原"的
 * 互相覆盖 ⇒ 症状是随机变红、看不出原因。只有一份来源，"要加什么"就只有一个地方可改 ✓。
 *
 * # ⚠ `--no-sandbox` 只能是**显式开关**，不能是默认
 *
 * 关掉 Chromium 的沙箱是**降级**（渲染进程不再与内核隔离）。"某台机器上必须加"
 * （受限沙箱里 `chrome-headless-shell` 不带它直接 `Target crashed` / CDP 调用超时）
 * **不等于**所有人都该关掉 ✗ —— 普通开发机与 CI 都不需要它。所以：**默认不加**，
 * 要加就显式给一个环境变量：
 *
 * ```bash
 * LITE_CHROME_NO_SANDBOX=1 npm run test:demo
 * ```
 */

/** 环境变量"算不算打开"：空 / `0` / `false` / `no` 都当没开（免得 `=0` 被当成真）。 */
const noSandbox = () => {
  const v = (process.env.LITE_CHROME_NO_SANDBOX ?? '').trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no'
}

/**
 * 公共前缀参数（`--headless` + 可选的 `--no-sandbox` + `--disable-gpu`）。
 *
 * 各自的私有参数（`--hide-scrollbars` / `--window-size` / `--virtual-time-budget` /
 * `--dump-dom` / URL）由调用方自己往后接 —— 那部分本来就不一样，没必要统一。
 */
export const headlessFlags = () => ['--headless', ...(noSandbox() ? ['--no-sandbox'] : []), '--disable-gpu']
