import { parseSync } from "oxc-parser";
//#region ast.ts
/**
* AST 适配层：把 **oxc-parser** 的 ESTree 形状，适配成编译器要用的那一小撮接口
* —— 本文件是唯一 import `oxc-parser` 的地方。
*
* 编译器的代码生成**完全不用解析器的 printer**（产物是自写的字符串拼接）⇒ 换解析器
* **不改产物形状**，只改"怎么读源码"。编译器里只有一小撮代码碰 AST，且只做三类事：
* "这是哪种节点" / "取字段" / "按位置切源码" —— 收进本文件后，换解析器只动这里加一次机械改名。
*
* 做法是**一次 normalize 遍历**，把 TS 口径的别名与 `kind` 挂到节点上，而不是在编译器里
* 逐处改写字段：oxc 的字段名与 TS 不同（`Literal.value` vs `.text` 等），且有一处**结构**
* 差异 —— TS 把自闭合元素当独立节点，oxc 里它也是 `JSXElement`，靠 `openingElement.selfClosing` 区分。
*
* ⚠ 代价：别名是**拷贝**（同一个子节点被两个键指向）⇒ `forEachChild` 必须跳过别名键，
* 否则同一节点被访问两次 —— `exprWithJsx` 靠它收集替换区间，重复访问会产出重复编辑。
* 于是每个挂过别名的节点都记一份 `__alias` 名单。
*
* ⚠ 本层类型是**宽松**的（`[key: string]: any`）：逐字段强类型只会把移植变成类型体操。
* 行为不靠类型保证，靠 `regress/compiler.mjs` 的负例，以及"18 个真实页面 tsx 的产物
* 逐字节一致"这条黄金样本口径。
*/
/** 编译器里仅有的三处 `SyntaxKind` 比较（字面量真假与 null）。 */
var SyntaxKind = {
	NullKeyword: "NullKeyword",
	TrueKeyword: "TrueKeyword",
	FalseKeyword: "FalseKeyword"
};
/** 别名（拷贝出来的键）在这里登记，`forEachChild` 跳过 —— 否则子节点被访问两次。 */
var ALIAS = "__alias";
var alias = (n, key, value) => {
	n[key] = value;
	(n[ALIAS] ?? (n[ALIAS] = [])).push(key);
};
/** 归一化后 `kind` 会变成 TS 口径的名字（只在这三处不同，其余 `kind === type`）。 */
var literalKind = (v) => v === null ? "NullKeyword" : v === true ? "TrueKeyword" : v === false ? "FalseKeyword" : void 0;
/**
* 一次遍历，把 TS 口径的别名挂到节点上。用显式栈（不用递归）：源码是用户写的，
* 嵌套深度不设上限，递归版本在深层 JSX 上会把栈吃穿。
*/
function normalize(program) {
	/**
	* ⚠ 两遍走，而且第二遍要**反向**：
	* JSXElement 的别名读的是它 `openingElement.attributes`（那要被上一条规则换成包装节点），
	* 父节点先处理就会读到**还没换的数组** ⇒ `opening.attributes.properties is not iterable`。
	* 收集顺序是父在前、子在**后**入栈，所以倒着处理正好是"子先父后"。
	*/
	const all = [];
	const stack = [program];
	while (stack.length) {
		const n = stack.pop();
		if (!n || typeof n !== "object" || typeof n.type !== "string") continue;
		all.push(n);
		for (const key of Object.keys(n)) {
			if (key === ALIAS) continue;
			const v = n[key];
			if (Array.isArray(v)) {
				for (const c of v) if (c && typeof c === "object" && typeof c.type === "string") stack.push(c);
			} else if (v && typeof v === "object" && typeof v.type === "string") stack.push(v);
		}
	}
	for (let i = all.length - 1; i >= 0; i--) apply(all[i]);
}
/** 单节点归一化（别名与 `kind`）。 */
function apply(n) {
	n.kind = n.type;
	switch (n.type) {
		case "Literal": {
			const k = literalKind(n.value);
			if (k) n.kind = k;
			n.text = typeof n.value === "string" ? n.value : n.value === null || n.value === true || n.value === false ? String(n.value) : n.raw;
			break;
		}
		case "Identifier":
		case "JSXIdentifier":
			n.text = n.name;
			break;
		case "JSXText":
			n.text = n.raw ?? n.value;
			break;
		case "TemplateLiteral":
			if (!n.expressions?.length) {
				n.kind = "NoSubstitutionTemplateLiteral";
				n.text = n.quasis?.[0]?.value?.cooked ?? n.quasis?.[0]?.value?.raw;
			}
			break;
		case "JSXAttribute":
			alias(n, "initializer", n.value);
			break;
		case "JSXOpeningElement": {
			const attrs = Array.isArray(n.attributes) ? n.attributes : [];
			n.attributes = {
				type: "JsxAttributes",
				kind: "JsxAttributes",
				start: attrs[0]?.start ?? n.start,
				end: attrs[attrs.length - 1]?.end ?? n.end,
				properties: attrs
			};
			alias(n, "tagName", n.name);
			break;
		}
		case "ArrowFunctionExpression":
		case "FunctionExpression":
		case "FunctionDeclaration":
			alias(n, "parameters", (Array.isArray(n.params) ? n.params : []).map((q) => ({
				type: "Parameter",
				kind: "Parameter",
				start: q.start,
				end: q.end,
				name: q
			})));
			break;
		case "JSXElement": {
			const opening = n.openingElement;
			if (opening?.selfClosing) n.kind = "JsxSelfClosingElement";
			alias(n, "tagName", opening?.name);
			alias(n, "attributes", opening?.attributes ?? []);
			break;
		}
		case "ConditionalExpression":
			alias(n, "condition", n.test);
			alias(n, "whenTrue", n.consequent);
			alias(n, "whenFalse", n.alternate);
			break;
		case "Property":
			alias(n, "name", n.key);
			alias(n, "initializer", n.value);
			break;
		case "CallExpression":
		case "NewExpression":
			alias(n, "expression", n.callee);
			break;
		case "MemberExpression":
			alias(n, "expression", n.object);
			alias(n, "name", n.property);
			break;
		case "JSXSpreadAttribute":
			alias(n, "expression", n.argument);
			break;
		case "JSXExpressionContainer":
 /**
		* ⚠ TS 对**空表达式容器**（`{/* 注释 *\/}`、`{}`、`{ }`）一律给 `expression === undefined`，
		* 而 oxc 给一个 `JSXEmptyExpression` 节点 —— 三种写法都对过拍。这个差别会**改产物**：
		* 编译器靠 `if (!child.expression) continue` 跳过它们，oxc 的节点是真值 ⇒ 会当成动态子
		* 节点多吐一个 `<!---->` 锚点（黄金样本抓出来的）。所以这里镜像 TS 的口径。
		*/
		if (n.expression?.type === "JSXEmptyExpression") n.expression = void 0;
	}
}
/** 解析 TSX。抛错交给调用方（编译器要把语法错误变成一条可读的失败信息）。 */
function parse(source, fileName) {
	const r = parseSync(fileName, source);
	const program = r.program;
	normalize(program);
	return {
		fileName,
		source,
		program,
		errors: r.errors ?? []
	};
}
/** 遍历子节点。**跳过别名键**（见文件头：重复访问会让 `exprWithJsx` 产出重复编辑）。 */
function forEachChild(node, cb) {
	const skip = node[ALIAS];
	for (const key of Object.keys(node)) {
		if (key === ALIAS || skip?.includes(key)) continue;
		const v = node[key];
		if (Array.isArray(v)) {
			for (const c of v) if (c && typeof c === "object" && typeof c.type === "string") cb(c);
		} else if (v && typeof v === "object" && typeof v.type === "string") cb(v);
	}
}
/** TS 的 `node.getStart(sf)`：跳过前导空白/注释后的起点 —— oxc 的 `start` 就是这个语义。 */
var getStart = (node) => node.start;
/** TS 的 `node.getEnd()`。 */
var getEnd = (node) => node.end;
/** 按位置取行号（0 基，与 TS 的 `getLineAndCharacterOfPosition().line` 同口径）。 */
function lineOf(sf, pos) {
	let line = 0;
	for (let i = 0; i < pos && i < sf.source.length; i++) if (sf.source.charCodeAt(i) === 10) line++;
	return line;
}
var isStringLiteral = (n) => n.kind === "Literal" && typeof n.value === "string";
var isNumericLiteral = (n) => n.kind === "Literal" && typeof n.value === "number";
var isNoSubstitutionTemplateLiteral = (n) => n.kind === "NoSubstitutionTemplateLiteral";
var isIdentifier = (n) => n.type === "Identifier";
var isJsxElement = (n) => n.kind === "JSXElement";
var isJsxSelfClosingElement = (n) => n.kind === "JsxSelfClosingElement";
var isJsxFragment = (n) => n.type === "JSXFragment";
var isJsxExpression = (n) => n.type === "JSXExpressionContainer";
var isJsxText = (n) => n.type === "JSXText";
var isJsxAttribute = (n) => n.type === "JSXAttribute";
var isJsxSpreadAttribute = (n) => n.type === "JSXSpreadAttribute";
var isConditionalExpression = (n) => n.type === "ConditionalExpression";
var isPropertyAccessExpression = (n) => n.type === "MemberExpression";
var isPropertyAssignment = (n) => n.type === "Property";
var isCallExpression = (n) => n.type === "CallExpression";
var isArrowFunction = (n) => n.type === "ArrowFunctionExpression";
var isFunctionExpression = (n) => n.type === "FunctionExpression";
var isBlock = (n) => n.type === "BlockStatement";
var isParenthesizedExpression = (n) => n.type === "ParenthesizedExpression";
//#endregion
//#region compiler.ts
/**
* lite 编译器：TSX → 模板串 + 逐槽 effect。结构参考 Solid 的 babel-plugin-jsx-dom-expressions。
*
* `<li class={p.n % 2 ? 'odd' : 'even'}>{p.label}:{p.n}</li>` 编译成：
* ```js
* const _t0 = template('<li>:')
* const _n0 = _t0(), _n1 = _n0.childNodes[1]
* setNodes(_n0, () => p.label, _n1)          // 插在静态的 ":" 之前
* setNodes(_n0, () => p.n, null)             // 末尾 ⇒ 锚点 null
* effect(() => setClass(_n0, p.n % 2 ? 'odd' : 'even'))
* ```
* 1. 静态结构折进 `template()` 克隆；动态位置在模板里只留一个占位注释，路径由编译器算好。
* 2. 每个 JSX 表达式编成一个立即执行的箭头函数 ⇒ 语句待在自己的块里，不必往宿主函数插语句。
* 3. 动态 prop 用 getter（Solid 同款，Vapor 用函数）：运行期零魔法，不必猜值是 prop 还是回调。
* 4. 与 Solid 有意不同：`.map()` 编成键控 `createFor`（不要求回调返回 JSX 字面量）；事件不委托
*    （Solid 用 `$$click` + `delegateEvents`）。与 Vapor 的取舍见 docs/pitfalls.md「与 Vapor 的已知差异」。
* 5. 占位注释就是锚点（为什么不能用"后面那个静态兄弟"，见 `dynChild`）；事件处理器自动包 `batch`。
* ⚠ 只支持一个语法子集：哪些写法抛错、哪些会静默编错见 `checkDirective` / `claimKey` / `mapCallback`。
*/
/**
* 这些属性改 property 比改 attribute 更对（布尔类）。
* ⚠ `value` **不在**这里：它走 `setValue`（property 与 attribute 都写，见 `src/dom.ts`），
* 只写 property 的话只读展示框（`<input value={x} readonly>`）在 DOM 里看不到值。
*/
var PROPS = /* @__PURE__ */ new Set([
	"checked",
	"selected",
	"disabled",
	"open",
	"multiple",
	"readonly",
	"required",
	"muted"
]);
var VOID = /* @__PURE__ */ new Set([
	"img",
	"br",
	"hr",
	"input",
	"meta",
	"link",
	"source",
	"area",
	"base",
	"col",
	"embed",
	"track",
	"wbr",
	"path",
	"circle",
	"rect",
	"line",
	"polyline",
	"polygon",
	"use",
	"stop",
	"ellipse"
]);
var escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
var escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
/** 属性值可以**折进模板串**的字面量：字符串 / 数字（`false`/`null` 不行，见 `html()` 里的注释）。 */
function foldLiteral(e) {
	if (isStringLiteral(e) || isNoSubstitutionTemplateLiteral(e)) return e.text;
	if (isNumericLiteral(e)) return e.text;
}
/**
* JSX 文本的空白语义 —— 与 `vue-jsx-vapor` 的实际产物**逐字符对齐**（不是照 Babel）。
*
* 拿各种形状的 JSX 过一遍 `vue-jsx-vapor/vite`，看它生成的 `template("…")` 字符串：
* `\n    第一行\n    第二行\n  ` → `第一行\n    第二行`（行间换行与缩进原样保留）；
* `a  <b>c</b>  d` → 原样不折叠；`\n  <b>x</b>\n  <i>y</i>\n` → `<b>x</b><i>y</i>`
* （纯空白跨行整段丢掉）。⇒ 规则：
*
* 1. **整段纯空白**：不含换行 ⇒ 一个空格；含换行 ⇒ 整段丢掉；
* 2. 否则**只裁"含换行的"首尾空白段** —— 不含换行的那点空格是行内空格，Vue 原样保留
*    （`\n  耗时 {x}` 里 `耗时 ` 后面那个空格就属于这种）。
*
* ⚠ 按 Babel 的 `cleanJSXElementLiteralChild` 写（行间补空格、整体 trim）会差一两个空格、
* 甚至丢掉换行 —— 只有逐字符比对才抓得出来。
*/
function jsxText(raw) {
	if (!/[^ \t\r\n]/.test(raw)) return raw.includes("\n") ? "" : " ";
	let s = raw;
	const head = /^[ \t\r\n]+/.exec(s)?.[0] ?? "";
	if (head.includes("\n")) s = s.slice(head.length);
	const tail = /[ \t\r\n]+$/.exec(s)?.[0] ?? "";
	if (tail.includes("\n")) s = s.slice(0, s.length - tail.length);
	return s;
}
/**
* 语法子集的边界 —— **拦不拦分两类，别看错**：
* * **直接抛错**：指令式属性（`v-if` / `vIf` 这种形状）、`.map` 之外的 `key`、
*   组件上的 spread、空元素带子节点、块体 `.map` 拿不到返回值那类写法
*   （`regress/compiler.mjs` 的负例逐条钉住）；
* * **静默编错**（不抛，产物是错的）：`class` 数组 / `class` 对象 / `style` 对象 /
*   `ref=` / 小写 `onclick=`。例如 `class={[a,b]}` 原样进 `setClass` ⇒ `String(数组)`。
*
* ⚠ 这五条不检测：加拦截等于为不存在的需求付字节，还会误伤同名的普通属性
* （`ref` 在 HTML 里本来就是合法属性名）。类型检查也兜不住 —— JSX 属性是 `any`（`jsx.d.ts`）。
* 设计与取舍见 docs/design.md。
*/
var Compiler = class {
	sf;
	src;
	runtime;
	helpers = /* @__PURE__ */ new Set();
	templates = [];
	/**
	* 被 `.map()` 认领的 `key` 属性节点。
	* 只有在这里登记过的才算数：登记在 `.map` 那条分支，消费在 `html()`/`component()` 走到那个
	* 元素时；没登记过的 `key` 一律抛错（见 `claimKey`）。
	*/
	mapKeys = /* @__PURE__ */ new Set();
	constructor(sf, src, runtime) {
		this.sf = sf;
		this.src = src;
		this.runtime = runtime;
	}
	/** 带位置的抛错。没有位置的编译错误等于让人回去 grep 一遍文件。 */
	fail(msg, node) {
		const at = node ? `${this.sf.fileName.replace(/^.*[\\/]/, "")}:${lineOf(this.sf, getStart(node)) + 1} ` : "";
		throw new Error(`[lite] ${at}${msg}`);
	}
	/**
	* Vue 的模板指令在 JSX 里**不会报错，只会变成一个没人理的属性**：`v-if="ok"` 走静态属性
	* 那条路 ⇒ 条件根本没生效，而类型检查与构建全绿。所以在认属性名的两个入口各拦一次。
	* ⚠ 只管 `vIf`（驼峰）与 `v-if`（连字符）——`@click` 那种带 `@` 的属性名 **TSX 本身就解析
	* 不过**，由 `parseError` 拦；也**不带** `:xxx`：`xmlns:xlink` 那类命名空间属性是真 SVG
	* 属性，`data-*` / `aria-*` 更不该管。
	*/
	checkDirective(attr, name) {
		if (/^v[A-Z]/.test(name) || /^v-/.test(name)) this.fail(`不支持指令式属性：${name} —— 本框架没有模板指令。条件渲染写 \`cond ? <…/> : null\`，列表写 \`list.value.map(…)\`，事件写 \`onClick={…}\``, attr);
	}
	/**
	* 处理 `key`：被 `.map` 认领过就放过（它不进 DOM），否则抛错。
	* ⚠⚠ `key` 写在 `.map` 之外的位置**必须抛错**：它是 React/Vue 的肌肉记忆，而这里没有
	* "按 key 决定复不复用"的那一次 diff —— `key` 只有一个消费者：`.map()` 那一列的 `createFor`。
	* 写在别处会被**静默丢掉**（代码里写着 key、注释解释"key 不能省"、界面上它什么都没做），
	* 宁可编译不过，也别让人带着假的安全走动（见 docs/pitfalls.md「编译期"静默编错"的几种写法」）。
	*/
	claimKey(attr, name) {
		if (name !== "key") return;
		if (!this.mapKeys.delete(attr)) this.fail("这里的 `key` 什么都不做：它只对 `.map()` 返回的那个元素有意义（交给 createFor 当复用键）。条件分支/普通元素上请直接删掉 —— 本框架没有\"按 key 决定复不复用\"的那一次 diff，不会因为它换实例", attr);
	}
	/**
	* 记下一个 helper，返回**生成代码里用的名字**（带 `_$` 前缀）。
	* 前缀是必须的：业务文件自己也会 `import { batch } from '@asunajs/lite'`（事件处理器里手写
	* `batch(...)`）—— 生成代码若直接用 `batch`，两行 import 就会撞名报
	* `Identifier 'batch' has already been declared`。所以生成代码用别名、import 也写别名。
	*/
	h(name) {
		this.helpers.add(name);
		return `_$${name}`;
	}
	srcOf(node) {
		return this.src.slice(getStart(node), getEnd(node));
	}
	tpl(html) {
		const name = `_t${this.templates.length}`;
		/**
		* ⚠ 那个 **PURE 标注**（写在 `template(` 调用前）**不是装饰**：这是产物里唯一的**模块级调用**，
		* 而打包器默认把"调用"当成可能有副作用 ⇒ 一个**没被引用**的组件，它的整段静态 DOM 照样
		* 留在产物里（实测：40 行静态标记白付 443 B gzip）。标上之后，没被引用的模板整段被摇掉。
		*
		* `template()` 确实是纯的（`createElement('template')` + `innerHTML` + 返回一个克隆函数，
		* 不碰任何全局状态），所以这个标注是**承诺而不是猜测** —— 见 `dom.ts` 里它的实现。
		*/
		this.templates.push(`const ${name} = /*#__PURE__*/ ${this.h("template")}(${JSON.stringify(html)})`);
		return name;
	}
	/** 编译一个 JSX 表达式：语句封在自己的块里，返回它的值。 */
	root(node) {
		const stmts = [];
		const value = this.value(node, stmts);
		return `(() => {\n${stmts.map((s) => "  " + s).join("\n")}\n  return ${value}\n})()`;
	}
	/**
	* 与 `value` 相同，但**语句封在自己的块里**：嵌套 JSX（组件插槽里的元素、列表项、条件分支）
	* 必须走这个入口，否则内层元素生成的 `const _n0 = …` 会和外层撞名
	* （`Identifier '_n0' has already been declared`）。
	*/
	valueIsolated(node) {
		const local = [];
		const v = this.value(node, local);
		if (!local.length) return v;
		return `(() => {\n${local.map((l) => "  " + l).join("\n")}\n  return ${v}\n})()`;
	}
	/** 任意 JSX 节点 → 一个表达式的值（元素 / 组件 / 片段）。 */
	value(node, stmts) {
		if (isJsxFragment(node)) {
			const parts = node.children.map((c) => this.childValue(c, true)).filter((v) => !!v);
			return parts.length === 0 ? "null" : parts.length === 1 ? parts[0] : `[${parts.join(", ")}]`;
		}
		const tag = this.tagOf(node);
		return /^[A-Z]/.test(tag) || tag.includes(".") ? this.component(node) : this.element(node, stmts);
	}
	tagOf(node) {
		return this.srcOf(isJsxElement(node) ? node.openingElement.tagName : node.tagName);
	}
	component(node) {
		const opening = isJsxElement(node) ? node.openingElement : node;
		const props = [];
		for (const attr of opening.attributes.properties) {
			if (isJsxSpreadAttribute(attr)) throw new Error("组件上的 {...spread} 未支持");
			const name = this.srcOf(attr.name);
			this.checkDirective(attr, name);
			this.claimKey(attr, name);
			if (name === "key") continue;
			const init = attr.initializer;
			if (!init) {
				props.push(`${name}: true`);
				continue;
			}
			if (isStringLiteral(init)) {
				props.push(`${JSON.stringify(name)}: ${JSON.stringify(init.text)}`);
				continue;
			}
			if (isJsxExpression(init) && init.expression) {
				props.push(`get ${JSON.stringify(name)}() { return ${this.exprWithJsx(init.expression)} }`);
				continue;
			}
			throw new Error(`不支持的组件属性：${name}`);
		}
		const slots = [];
		if (isJsxElement(node) && node.children.length) {
			const parts = node.children.map((c) => this.childValue(c)).filter((v) => !!v);
			slots.push(`default: () => ${parts.length === 0 ? "null" : parts.length === 1 ? parts[0] : `[${parts.join(", ")}]`}`);
		}
		return `${this.h("createComponent")}(${this.tagOf(node)}, { ${props.join(", ")} }${slots.length ? `, { ${slots.join(", ")} }` : ""})`;
	}
	/**
	* 复制一段表达式的源码，但把它内部的 JSX 全部递归编译掉。
	* ⚠ 少了这一步会**静默漏掉 JSX**：片段成员 `{cond ? null : <div>…</div>}`、或数组字面量里的
	* 三元分支走到"普通表达式"路径时若原样复制，产物里就留着 JSX ⇒ 下游解析器直接报
	* `Unexpected JSX expression`（应用的根返回就是这个形状）。
	*/
	exprWithJsx(node) {
		const base = getStart(node);
		const edits = [];
		const walk = (n, inJsx) => {
			const isJsx = isJsxElement(n) || isJsxSelfClosingElement(n) || isJsxFragment(n);
			if (isJsx && !inJsx) {
				edits.push({
					start: getStart(n) - base,
					end: getEnd(n) - base,
					text: this.valueIsolated(n)
				});
				return;
			}
			forEachChild(n, (c) => walk(c, inJsx || isJsx));
		};
		walk(node, false);
		if (!edits.length) return this.srcOf(node);
		let out = this.srcOf(node);
		for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
		return out;
	}
	/**
	* 组件子节点 / 片段成员：拿一个"值"（文本要自己造节点）。
	* `slot = true` 时把动态成员包成惰性槽（只有片段需要，见 runtime 的 `lazySlot`）。
	*/
	childValue(child, slot = false) {
		if (isJsxText(child)) {
			const t = jsxText(child.text);
			return t ? `document.createTextNode(${JSON.stringify(t)})` : void 0;
		}
		if (isJsxExpression(child)) {
			if (!child.expression) return void 0;
			if (isNullish(child.expression)) return void 0;
			const e = this.exprWithJsx(child.expression);
			return slot ? `${this.h("lazySlot")}(() => ${e})` : e;
		}
		return this.valueIsolated(child);
	}
	element(node, stmts) {
		const built = this.html(node, stmts, []);
		const tpl = this.tpl(built.html);
		const rootVar = `_n0`;
		stmts.push(...this.materialize(built.bindings, tpl, rootVar));
		stmts.push(...this.emit(built.bindings, rootVar));
		return rootVar;
	}
	/**
	* 生成静态 HTML 与绑定表：静态结构折进模板串，动态子节点只留一个 `<!---->` 占位注释当锚点
	* （为什么必须留，见 `dynChild`）。
	*/
	html(node, stmts, base) {
		const opening = isJsxElement(node) ? node.openingElement : node;
		const tag = this.tagOf(node);
		if (/^[A-Z]/.test(tag) || tag.includes(".")) throw new Error("组件只能出现在动态子节点位置");
		const attrs = [];
		const own = [];
		for (const attr of opening.attributes.properties) {
			if (isJsxSpreadAttribute(attr)) {
				own.push({
					kind: "spread",
					at: [],
					expr: this.srcOf(attr.expression)
				});
				continue;
			}
			const name = this.srcOf(attr.name);
			this.checkDirective(attr, name);
			this.claimKey(attr, name);
			if (name === "key") continue;
			const init = attr.initializer;
			if (!init) {
				attrs.push(name);
				continue;
			}
			if (isStringLiteral(init)) {
				attrs.push(`${name}="${escAttr(init.text)}"`);
				continue;
			}
			if (isJsxExpression(init) && init.expression) {
				/**
				* 字符串/数字字面量**直接折进模板串**（Vapor 也这么做）：少一次运行期写入，且静态属性
				* 按源码顺序排在模板里、动态属性由 setter 之后追加 —— `rows={3}` 折不折决定它排第 2
				* 还是排最后（逐字符比对能看出来）。
				* ⚠ `false`/`null` 不折：布尔属性写进 HTML 是"存在即为真"，`disabled={false}` 折成
				* `disabled="false"` 会把它**打开**（语义反了）。
				*/
				const folded = foldLiteral(init.expression);
				if (folded !== void 0) {
					attrs.push(`${name}="${escAttr(folded)}"`);
					continue;
				}
				const expr = this.exprWithJsx(init.expression);
				if (name.length > 2 && name.startsWith("on") && /^[A-Z]/.test(name[2])) own.push({
					kind: "event",
					at: [],
					name: name.slice(2).toLowerCase(),
					expr
				});
				else own.push({
					kind: "attr",
					at: [],
					name,
					expr,
					hoist: isLiteral(init.expression)
				});
				continue;
			}
			throw new Error(`不支持的属性：${name}`);
		}
		const children = isJsxElement(node) ? node.children : [];
		const parts = [];
		const childBindings = [];
		/** 本元素里的动态子节点（占位注释 + 铺节点），登记完统一追加到 `childBindings`。 */
		const dyns = [];
		/**
		* `dom` 是**真正产出节点的下标** —— 路径 `childNodes[dom]` 用的是它。
		* ⚠ 每个进 HTML 的东西都要占一个下标，**包括占位注释**（它确实是 DOM 里的一个节点）：
		* 漏数任何一个，后面的静态节点就整体错位 ⇒ 锚点指到隔壁，渲染出 `:a1` 这种顺序。
		*/
		let dom = 0;
		/**
		* 上一个进模板的节点**是不是文本**：相邻两段文本在 HTML 解析后**合成一个节点**，所以
		* `childNodes` 下标要按合并后的数。`<span>将结束{' '}<b>…</b></span>` 里两段文本只有一个文本
		* 节点，`<b>` 是 `childNodes[1]`；按"每段文本各占一位"数会算成 `[2]` ⇒ 运行期拿文本节点当父
		* 节点去 `insertBefore`，抛 `HierarchyRequestError: This node type does not support this method`。
		*/
		let textTail = false;
		/**
		* 登记一个动态子节点：**它自己带一个 `<!---->` 占位注释**，这个注释就是它的锚点。
		* ⚠⚠ 占位是**必须**的，不能靠"后面那个静态兄弟"当锚点：动态兄弟后面还有动态兄弟时，
		* 后者没有静态兄弟可指，两者的锚点都是 `null`（= 追加到末尾），最终顺序就取决于
		* **谁的 effect 后重跑**而不是文档顺序 —— 一个先渲染、另一个晚一步（数据异步）后追加，
		* 就跑到前面去了。占位注释把槽的位置**钉死**（见 docs/pitfalls.md「锚点：动态子节点为什么会错位」）。
		* 顺带解决文本合并：`<span>a{dyn}b</span>` 的两段文本被注释分开，不再是同一个节点。
		* ⚠ 锚点是**编译器自己持有的节点引用**，可能被别处摘走 ⇒ 运行期的 `insert()` 里有护栏。
		*/
		const dynChild = (binding) => {
			parts.push("<!---->");
			binding.anchor = [...base, dom];
			dom++;
			dyns.push(binding);
			textTail = false;
		};
		for (const child of children) {
			if (isJsxText(child)) {
				const t = jsxText(child.text);
				if (!t) continue;
				parts.push(escText(t));
				if (!textTail) dom++;
				textTail = true;
				continue;
			}
			if (isJsxExpression(child)) {
				if (!child.expression) continue;
				const lit = literalHtml(child.expression);
				if (lit !== void 0) {
					if (lit) {
						parts.push(lit);
						if (!textTail) dom++;
						textTail = true;
					}
					continue;
				}
				dynChild(this.dynamic(child, stmts, [...base, dom]));
				continue;
			}
			if (isJsxFragment(child) || /^[A-Z]/.test(this.tagOf(child)) || this.tagOf(child).includes(".")) {
				dynChild({
					kind: "nodes",
					parent: [...base],
					anchor: null,
					expr: `() => ${this.valueIsolated(child)}`
				});
				continue;
			}
			const sub = this.html(child, stmts, [...base, dom]);
			parts.push(sub.html);
			childBindings.push(...sub.bindings);
			dom++;
			textTail = false;
		}
		childBindings.push(...dyns);
		const inner = parts.join("");
		const open = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
		/**
		* ⚠⚠ **HTML 里没有"自闭合"这回事**（除了空元素）：JSX 允许把任意元素写成 `<label ... />`，
		* 但 `<label>` 不是空元素 —— 生成 `<label ...>` 交给 HTML 解析器，它会把**后面的兄弟节点
		* 吞成 label 的子节点**。
		* 后果不是"报错看得见"：编译期算好的 `childNodes[i]` 路径全部错位一格，运行期在 effect 里
		* 抛 `Cannot read properties of undefined (reading 'firstChild')`；错误若被 `try/catch`
		* 吞掉，表现成整页空白、`window.onerror` 一声不响。
		*/
		if (VOID.has(tag) && children.length) throw new Error(`lite 编译器不支持的写法：空元素 <${tag}> 不能带子节点（生成 HTML 无法表达）`);
		const html = VOID.has(tag) ? open : `${open}${inner}</${tag}>`;
		const ownShifted = own.map((b) => ({
			...b,
			at: [...base]
		}));
		/**
		* ⚠⚠ `<select>` 的 `value` 必须**等选项建出来之后再写**。
		* `<select>` 没有"哪个选项被选中"的独立状态：`value` 是**在选项集合上算出来的**。先写
		* `value=''`（没有选项匹配空串）时属性的值确实是 `''`，但随后插入 `<option>` 会触发浏览器
		* 的**自动选中**：实测「反序插两个 option」的结果是**最后一个被选中**
		* （`append(b); insertBefore(a, b)` ⇒ `value === 'b'`），下拉框自己跳到了别处。
		* Vapor 也是这么排的：先生成"建选项"、再生成"写值"（拿切页之后下拉框的 property 比出来的）。
		*/
		const isValueAttr = (b) => b.kind === "attr" && b.name === "value";
		const late = tag === "select" ? ownShifted.filter(isValueAttr) : [];
		return {
			html,
			bindings: [
				...ownShifted.filter((b) => !late.includes(b)),
				...childBindings,
				...late
			]
		};
	}
	/**
	* 拆开 `.map()` 的回调：参数名 + **返回的那一行**。只认**表达式体** `(x) => <Row …/>`。
	* ⚠⚠ 块体（`xs.map((x) => { const a = …; return <Row/> })`）**故意不认**，走通用路径：
	* 列表行只在建那一行时跑一次回调，块体里 `return` 之前那几句（典型 `const active =
	* page.value === id`）是在**任何 effect 之外**读信号的 ⇒ 信号变了不会重跑它，列表源又是
	* 常量数组时那一行就**永久停在建出来那一刻的值**上。
	* 表达式体没这个问题：它的每个动态值都编译成绑定 effect，信号是**在 effect 里**读的。
	* 其余形状（不返回 JSX 的 `.map`、解构参数、参数多于两个）同样返回 `undefined`
	* ⇒ 走通用路径（整表重建，语义仍然对）。
	*/
	mapCallback(fn) {
		if (!(isArrowFunction(fn) || isFunctionExpression(fn))) return void 0;
		const ps = fn.parameters;
		if (ps.length < 1 || ps.length > 2 || ps.some((p) => !isIdentifier(p.name))) return void 0;
		if (isBlock(fn.body)) return void 0;
		return {
			fn,
			expr: isParenthesizedExpression(fn.body) ? fn.body.expression : fn.body
		};
	}
	/** 一个动态子节点的绑定。返回值只可能是 `nodes` / `for`（两者都是"往父节点里铺一批节点"）。 */
	dynamic(child, stmts, at) {
		const e = child.expression;
		const parent = at.slice(0, -1);
		const branchOk = (x) => isNullish(x) || isJsxElement(x) || isJsxSelfClosingElement(x) || isJsxFragment(x);
		if (isConditionalExpression(e) && hasJsx(e) && branchOk(e.whenTrue) && branchOk(e.whenFalse)) return {
			kind: "nodes",
			parent,
			anchor: null,
			expr: `() => ${this.srcOf(e.condition)} ? ${isNullish(e.whenTrue) ? "null" : this.branch(e.whenTrue)} : ${isNullish(e.whenFalse) ? "null" : this.branch(e.whenFalse)}`
		};
		if (isCallExpression(e) && isPropertyAccessExpression(e.expression) && e.expression.name.text === "map" && e.arguments.length === 1) {
			const cb = this.mapCallback(e.arguments[0]);
			if (cb && isJsxNode(cb.expr)) {
				const a = this.srcOf(cb.fn.parameters[0].name);
				const b = cb.fn.parameters.length > 1 ? this.srcOf(cb.fn.parameters[1].name) : "_i";
				let key;
				if (!isJsxFragment(cb.expr)) {
					const opening = isJsxElement(cb.expr) ? cb.expr.openingElement : cb.expr;
					for (const attr of opening.attributes.properties) if (isJsxAttribute(attr) && this.srcOf(attr.name) === "key" && attr.initializer && isJsxExpression(attr.initializer) && attr.initializer.expression) {
						key = this.srcOf(attr.initializer.expression);
						this.mapKeys.add(attr);
					}
				}
				const item = this.root(cb.expr);
				return {
					kind: "for",
					parent,
					anchor: null,
					list: this.srcOf(e.expression.expression),
					params: [a, b],
					item,
					key,
					positional: readsIdent(cb.expr, b)
				};
			}
		}
		return {
			kind: "nodes",
			parent,
			anchor: null,
			expr: `() => ${this.exprWithJsx(e)}`
		};
	}
	branch(e) {
		if (isJsxElement(e) || isJsxSelfClosingElement(e) || isJsxFragment(e)) return this.root(e);
		throw new Error("条件分支只支持 JSX 或 null");
	}
	/** 给绑定表里出现过的每个路径分配变量，并按文档顺序物化。 */
	materialize(bindings, tpl, root) {
		const paths = /* @__PURE__ */ new Map();
		const add = (p) => {
			if (p) paths.set(p.join("/"), p);
		};
		for (const b of bindings) if (b.kind === "attr" || b.kind === "event" || b.kind === "spread") add(b.at);
		else {
			add(b.parent);
			add(b.anchor);
		}
		for (const p of [...paths.values()]) for (let i = 1; i < p.length; i++) {
			const prefix = p.slice(0, i);
			paths.set(prefix.join("/"), prefix);
		}
		const sorted = [...paths.values()].sort((a, b) => a.length - b.length || a.join("/").localeCompare(b.join("/")));
		const lines = [];
		const vars = /* @__PURE__ */ new Map();
		vars.set("", root);
		let n = 0;
		const decls = [`const ${root} = ${tpl}()`];
		for (const p of sorted) {
			if (p.length === 0) continue;
			const name = `_n${++n}`;
			const parentPath = p.slice(0, -1);
			const parentVar = vars.get(parentPath.join("/")) ?? root;
			const idx = p[p.length - 1];
			decls.push(`      ${name} = ${parentVar}${idx === 0 ? ".firstChild" : `.childNodes[${idx}]`}`);
			vars.set(p.join("/"), name);
		}
		this.varOf = (p) => p.length === 0 ? root : vars.get(p.join("/")) ?? root;
		if (decls.length === 1) return decls;
		const merged = decls[0] + decls.slice(1).map((d) => "," + d.trim()).join("");
		lines.push(merged);
		return lines;
	}
	varOf = () => "_n0";
	emit(bindings, _root) {
		const out = [];
		const v = (p) => this.varOf(p);
		for (const b of bindings) switch (b.kind) {
			case "attr": {
				const two = b.name === "class" || b.name === "value";
				const fn = this.h(b.name === "class" ? "setClass" : b.name === "value" ? "setValue" : PROPS.has(b.name) ? "setProp" : "setAttr");
				const call = two ? `${fn}(${v(b.at)}, ${b.expr})` : `${fn}(${v(b.at)}, ${JSON.stringify(b.name)}, ${b.expr})`;
				out.push(b.hoist ? call : `${this.h("effect")}(() => ${call})`);
				break;
			}
			case "event":
				out.push(`${this.h("on")}(${v(b.at)}, ${JSON.stringify(b.name)}, (e) => ${this.h("batch")}(() => (${b.expr})(e)))`);
				break;
			case "spread":
				out.push(`${this.h("spread")}(${v(b.at)}, ${b.expr})`);
				break;
			case "nodes":
				out.push(`${this.h("setNodes")}(${v(b.parent)}, ${b.expr}, ${b.anchor ? v(b.anchor) : "null"})`);
				break;
			case "for": {
				const [a, i] = b.params;
				const key = b.key ? `(${a}, ${i}) => ${b.key}` : "null";
				out.push(`${this.h("createFor")}(${v(b.parent)}, () => ${b.list}, (${a}, ${i}) => ${b.item}, ${key}, ${b.anchor ? v(b.anchor) : "null"}, ${b.positional})`);
				break;
			}
		}
		return out;
	}
	finish(code) {
		/**
		* ⚠ 早退的判据**不能只看 `templates`**：`helpers` 里那些 `_$createComponent` / `_$setNodes`
		* 是**代码里真的会调用**的（上面的组件分支就会发 `createComponent`），漏注入 import 的后果是
		* 运行期 `ReferenceError: _$createComponent is not defined`，而**编译期一声不响** ——
		* 一个组件、没有静态元素时 `templates.length === 0`，只判模板就会把 import 吞掉，
		* 所以判据要连 `helpers.size === 0` 一起看。
		*/
		if (this.templates.length === 0 && this.helpers.size === 0) return {
			code,
			helpers: this.helpers
		};
		const lines = code.split("\n");
		let at = 0;
		for (let i = 0; i < lines.length; i++) if (/^\s*import\s/.test(lines[i])) at = i + 1;
		const importLine = this.helpers.size ? `import { ${[...this.helpers].sort().map((n) => `${n} as _$${n}`).join(", ")} } from '${this.runtime}'` : "";
		lines.splice(at, 0, [importLine, ...this.templates].filter(Boolean).join("\n"));
		return {
			code: lines.join("\n"),
			helpers: this.helpers
		};
	}
};
var isNullish = (e) => e.kind === SyntaxKind.NullKeyword || e.kind === SyntaxKind.FalseKeyword || isIdentifier(e) && e.text === "undefined";
var isLiteral = (e) => isStringLiteral(e) || isNumericLiteral(e) || isNoSubstitutionTemplateLiteral(e) || e.kind === SyntaxKind.TrueKeyword || e.kind === SyntaxKind.FalseKeyword || isNullish(e);
function hasJsx(e) {
	return isJsxElement(e) || isJsxSelfClosingElement(e) || isJsxFragment(e) || isConditionalExpression(e) && (hasJsx(e.whenTrue) || hasJsx(e.whenFalse));
}
var isJsxNode = (n) => isJsxElement(n) || isJsxSelfClosingElement(n) || isJsxFragment(n);
/**
* 这一段代码里**读了**某个变量名吗（用来决定列表行是否"位置敏感"）。
*
* ⚠ 判定要**按结构走**，不能"整段源码里搜一下这个名字"：`a.i` 的那截 `i` 是成员名、
* `<div i={…}>` 的 `i` 是属性名、`{ i: 1 }` 的 `i` 是键 —— 都不是读那个变量。反过来漏判
* 的代价不对称：多判一次只是重排时重建一行（丢一次 CSS 过渡），漏判则会把「第 3 步」这种
* 步号留在旧位置上 ⇒ 除了上面那三处**明确不算**，其余一律算读了（含嵌套箭头 `() => move(i)`）。
*/
function readsIdent(node, name) {
	if (isIdentifier(node)) return node.text === name;
	if (isPropertyAccessExpression(node)) return readsIdent(node.expression, name);
	if (isJsxAttribute(node)) return !!node.initializer && readsIdent(node.initializer, name);
	if (isPropertyAssignment(node)) return readsIdent(node.initializer, name);
	let found = false;
	forEachChild(node, (c) => {
		if (!found && readsIdent(c, name)) found = true;
	});
	return found;
}
function literalHtml(e) {
	if (isStringLiteral(e) || isNoSubstitutionTemplateLiteral(e)) return escText(e.text);
	if (isNumericLiteral(e)) return escText(e.text);
	if (isNullish(e) || e.kind === SyntaxKind.TrueKeyword || e.kind === SyntaxKind.FalseKeyword) return "";
}
/**
* 只在**源码本来就有语法错误**时才会命中的分支：解析器不抛，它把诊断攒在 `errors` 里，
* 节点树则是"就着残文能认多少认多少"。
* 为什么要单独判一句：不判的话 `compile` 会照常产出一段**残缺的**代码 ——
* `<div @click={f}>x</div>`（Vue 的事件简写，TSX 里非法）编出来是把元素吃掉、余下原文当尾巴
* 留下。下游转换器确实会报错，但那句 `Unexpected token` 与本文件隔着好几层，看着像编译器的
* bug；先在这里拦，报的是"你这一行写错了"。
*/
var parseError = (sf) => {
	const d = sf.errors[0];
	if (!d) return void 0;
	const line = lineOf(sf, d.labels?.[0]?.start ?? 0) + 1;
	return `[lite] ${sf.fileName.replace(/^.*[\\/]/, "")}:${line} 源码解析失败：${d.message}（TSX 里没有 Vue 的 @click / v-if：事件写 onClick，条件用三元）`;
};
/** 编译一个 TSX 源文件。 */
function compile(source, options = {}) {
	const runtime = options.runtime ?? "../src/index";
	const sf = parse(source, options.filename ?? "x.tsx");
	const bad = parseError(sf);
	if (bad) throw new Error(bad);
	const c = new Compiler(sf, source, runtime);
	const edits = [];
	const visit = (node, inJsx) => {
		const isJsx = isJsxElement(node) || isJsxSelfClosingElement(node) || isJsxFragment(node);
		if (isJsx && !inJsx) {
			edits.push({
				start: getStart(node),
				end: getEnd(node),
				text: c.root(node)
			});
			return;
		}
		forEachChild(node, (child) => visit(child, inJsx || isJsx));
	};
	visit(sf.program, false);
	let out = source;
	for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return c.finish(out);
}
//#endregion
export { compile as t };
