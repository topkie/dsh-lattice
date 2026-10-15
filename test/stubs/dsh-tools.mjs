// 宿主模块替身：只实现本项目用到的部分。
//
// **它必须像真实宿主那样转换 parameters。** 真实 dsh-tools 的 defineTool 会把
// 「属性名 → 值 schema」的映射转成 JSON Schema（补 type: object、把属性上的
// required: true 收成顶层 required 数组）。若替身原样返回，测试断言的就是一个
// 宿主永远不会产出的形态 —— 那等于在替身自己的错误上写测试。
export function defineTool(def) {
  const spec = def && def.parameters
  if (spec && typeof spec === 'object' && spec.type === undefined) {
    const properties = {}
    const required = []
    for (const [key, value] of Object.entries(spec)) {
      const { required: isRequired, ...rest } = value
      properties[key] = rest
      if (isRequired === true) required.push(key)
    }
    def = {
      ...def,
      parameters:
        required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties },
    }
  }
  return def
}
