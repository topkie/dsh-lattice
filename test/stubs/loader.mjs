const MAP = {
  '@deepseek-ai/dsh-tools': new URL('./dsh-tools.mjs', import.meta.url).href,
  '@deepseek-ai/schemastery': new URL('./schemastery.mjs', import.meta.url).href,
}

export function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: MAP[specifier], shortCircuit: true }
  return next(specifier, context)
}