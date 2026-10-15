// 编码器替身：模拟依赖不可用的情形。
// 真实行为（能否加载模型、编码质量）由 scripts/verify-encoder.mjs 在真实环境验证。
export const env = { remoteHost: '', cacheDir: '' }
export async function pipeline() {
  throw new Error('transformers 不可用（替身）')
}
