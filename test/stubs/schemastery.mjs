// 宿主模块替身：只实现本项目用到的链式调用。
function field(def) {
  const self = { _default: def }
  for (const m of ['default', 'min', 'max', 'description']) self[m] = () => self
  return self
}

export default {
  object: (shape) => ({ shape }),
  boolean: () => field(false),
  string: () => field(''),
  number: () => field(0),
  array: () => field([]),
}
