// 宿主模块的类型来源说明（**本文件不声明任何模块**）。
//
// 这里曾经把 @deepseek-ai/{cordis,dsh-tools,schemastery} 声明成 any 的替身。那等于把整块
// 宿主契约关在类型检查之外，与 docs/DEVELOPMENT.md「不使用 any；确有必要时写明原因」
// （CONTRIBUTING.md 有同一句）直接冲突：文档说不用，代码里三行都在用，谁也没写理由 ——
// 这正是 M2 审核 F11 记下的那处张力。
//
// 现在三者的类型都取自它们自己的包（peerDependencies，实测装得上）。删掉替身之后，
// 宿主的真类型**当场报出两处真问题**：src/tools/index.ts 的 textOutput() 少了字面量
// （type: 'string' / type: 'text'），导致宿主推不出返回值、一路落到 never。
// 那是被 any 掩住的类型错误，不是「写了更漂亮的类型」。
//
// 结论：本插件与宿主之间的类型边界**不需要**替身；将来若真需要，理由写在这里，
// 并回答「换了真类型会怎样」。

export {}
