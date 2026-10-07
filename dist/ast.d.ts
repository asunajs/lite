/** 一个 AST 节点。`kind` 是归一化后的种类名（多数与 `type` 相同，见下面的特例）。 */
export interface Node {
    type: string;
    kind: string;
    start: number;
    end: number;
    /**
     * 少数**结构性**字段给出具体类型（比索引签名更具体，于是赢）：有它们，
     * `node.children.map((c) => …)` 里的回调参数才是 `Node` 而不是隐式 any。
     * ⚠ 这三个声明成**必有**是刻意的：并不是每个节点都有 `children`（Identifier 就没有），
     * 但编译器只在"确定有"的地方读它们 —— 声明成可选只会换来十几处 `?? []` 与 `!`。
     * 其余字段一律走索引签名。
     */
    children: Node[];
    parameters: Node[];
    body: Node;
    [key: string]: any;
}
export type Expression = Node;
export type JsxChild = Node;
export type JsxElement = Node;
export type JsxSelfClosingElement = Node;
export type JsxFragment = Node;
export type JsxAttribute = Node;
export type JsxSpreadAttribute = Node;
export type JsxExpression = Node;
export type JsxText = Node;
export type ConditionalExpression = Node;
export type PropertyAccessExpression = Node;
export type PropertyAssignment = Node;
export type Identifier = Node;
export type StringLiteral = Node;
export type NumericLiteral = Node;
export type CallExpression = Node;
export type ObjectExpression = Node;
export type ArrowFunction = Node;
export type FunctionExpression = Node;
export type Block = Node;
export type ParenthesizedExpression = Node;
/**
 * 解析结果。`program` 是 ESTree 的 `Program`；`errors` 是 oxc 的语法错误
 * （`@click` 那类"TSX 本身就解析不过"的写法在这里被抓住，编译期报错靠它）。
 */
export interface SourceFile {
    fileName: string;
    source: string;
    program: Node;
    errors: {
        message: string;
        labels: {
            start: number;
            end: number;
        }[];
    }[];
}
/** 编译器里仅有的三处 `SyntaxKind` 比较（字面量真假与 null）。 */
export declare const SyntaxKind: {
    readonly NullKeyword: 'NullKeyword';
    readonly TrueKeyword: 'TrueKeyword';
    readonly FalseKeyword: 'FalseKeyword';
};
/** 解析 TSX。抛错交给调用方（编译器要把语法错误变成一条可读的失败信息）。 */
export declare function parse(source: string, fileName: string): SourceFile;
/** 遍历子节点。**跳过别名键**（见文件头：重复访问会让 `exprWithJsx` 产出重复编辑）。 */
export declare function forEachChild(node: Node, cb: (child: Node) => void): void;
/** TS 的 `node.getStart(sf)`：跳过前导空白/注释后的起点 —— oxc 的 `start` 就是这个语义。 */
export declare const getStart: (node: Node) => number;
/** TS 的 `node.getEnd()`。 */
export declare const getEnd: (node: Node) => number;
/** 按位置取行号（0 基，与 TS 的 `getLineAndCharacterOfPosition().line` 同口径）。 */
export declare function lineOf(sf: SourceFile, pos: number): number;
export declare const isStringLiteral: (n: Node) => boolean;
export declare const isNumericLiteral: (n: Node) => boolean;
export declare const isNoSubstitutionTemplateLiteral: (n: Node) => boolean;
export declare const isIdentifier: (n: Node) => boolean;
export declare const isJsxElement: (n: Node) => boolean;
export declare const isJsxSelfClosingElement: (n: Node) => boolean;
export declare const isJsxFragment: (n: Node) => boolean;
export declare const isJsxExpression: (n: Node) => boolean;
export declare const isJsxText: (n: Node) => boolean;
export declare const isJsxAttribute: (n: Node) => boolean;
export declare const isJsxSpreadAttribute: (n: Node) => boolean;
export declare const isConditionalExpression: (n: Node) => boolean;
export declare const isPropertyAccessExpression: (n: Node) => boolean;
export declare const isPropertyAssignment: (n: Node) => boolean;
export declare const isCallExpression: (n: Node) => boolean;
export declare const isArrowFunction: (n: Node) => boolean;
export declare const isFunctionExpression: (n: Node) => boolean;
export declare const isBlock: (n: Node) => boolean;
export declare const isParenthesizedExpression: (n: Node) => boolean;
