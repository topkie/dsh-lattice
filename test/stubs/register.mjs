// 把宿主提供的模块（@deepseek-ai/*）与可选依赖（@huggingface/transformers）映射到本地替身。
// 这些包由 DSH 运行时注入，不发布到公共 registry，因此本地开发与 CI 需要替身。
import { register } from 'node:module'

register(new URL('./loader.mjs', import.meta.url))