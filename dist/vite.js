import { t as compile } from "./chunks/compiler.js";
//#region vite.ts
/**
* lite 的 Vite 插件：把 TSX 编译成"模板串 + 逐槽 effect"（产物形状见 docs/design.md「编译器」）。
*
* `enforce: 'pre'` 是必须的：本插件要在下游转换器之前拿到还带 JSX 的源码
* （它折掉 JSX、保留 TS 语法，再由下游去类型）。
*
* ⚠ 别按"下游是不是 esbuild"来判断谁先谁后 —— 不同 Vite 大版本的下游实现换过
* （TS/JSX 现在由 rolldown 内建的 oxc 转），唯一稳的判据是插件自己的 `enforce: 'pre'`。
*
* 用法：
*
* ```ts
* import lite from '@asunajs/lite/vite'
* plugins: [lite({ runtime: '@asunajs/lite' })]
* ```
*/
function lite(options = {}) {
	const runtime = options.runtime ?? "@asunajs/lite";
	const include = options.include ?? /\.tsx$/;
	return {
		name: "lite",
		enforce: "pre",
		transform(code, id) {
			if (!include.test(id) || id.includes("node_modules")) return;
			const { code: out } = compile(code, {
				runtime,
				filename: id
			});
			return {
				code: out,
				map: null
			};
		}
	};
}
//#endregion
export { lite as default };
