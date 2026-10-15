// DSH 宿主提供的模块：本地不可安装，仅声明类型供编译期使用。
declare module '@deepseek-ai/schemastery' {
  const z: any
  export default z
}
declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(def: any): any
}
declare module '@deepseek-ai/cordis' {
  export type Context = any
}
declare module '@deepseek-ai/dsh-llm' {
  export type Llm = any
}