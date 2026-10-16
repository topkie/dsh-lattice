// 模块替换钩子。**目前只用于一处**：把可选依赖 @huggingface/transformers 换成必定失败的替身，
// 让「编码器不可用」这条降级路径在测试里是**确定性**的（否则有网络的机器会真的加载成功，语义就变了）。
//
// **不再替换宿主模块（@deepseek-ai/*）。** 它们是 peerDependencies，会从 registry 正常装上；
// 用真包才测得到真实的契约 —— 此前的替身因为缺了参数校验，凭空制造出一条假失败。
import { register } from 'node:module'

register(new URL('./loader.mjs', import.meta.url))
