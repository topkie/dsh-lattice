const MAP = {
  // 编码器是可选依赖：替身让它必定失败，用来覆盖降级路径。
  // 这**不是**模拟宿主行为，而是构造「依赖不可用」这个环境条件 ——
  // 没有它，降级用例会真的去加载模型（有网络时下载成功、用例反而失败）。
  '@huggingface/transformers': new URL('./transformers.mjs', import.meta.url).href,
}

export function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: MAP[specifier], shortCircuit: true }
  return next(specifier, context)
}
