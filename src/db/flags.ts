import type { ThresholdValue } from '../threshold-types.js'
// atom.flags 的位定义。
//
// 为什么单独成一个模块：这些位被**多个 pipeline 模块**读写（search / view / list /
// audit / archive / split / write）。它们曾经定义在 pipeline/write.ts，于是 search.ts
// 为了读 FLAG_ARCHIVED 反向 import write.ts，而 write.ts → review.ts → search.ts 已经是一条环。
// 环上的模块**单独加载**时会读到尚未初始化的绑定（TDZ 报错），dist/pipeline/search.js
// 与 dist/pipeline/audit.js 都曾因此直接 import 失败。
// 所以定义放在这个**没有内部依赖**的底层模块：位定义不属于任何一条管线，它是 schema 的一部分。
//
// 位值一旦写进库就不能改 —— 改它等于把历史行解释错。新增位只能往空位上加。
//
// bit0（1）待拆分（T29）：写入侧按长度切分时置上（见 writeReviewed），召回时在锚行标一句
//   「疑似应拆分」，由人在界面上确认或忽略。它说的是「切点按长度定的，没有按内容判断过」，
//   **不是**「这条一定该拆」—— 一条只讲一件事的长文本同样会被标上。
//   确认与忽略都清这一位，见 pipeline/split.ts。
// bit1（2）歧义：落位时「两个候选接近」而新建了主题（writeAtom 的 flags）—— 归属没定论，
//   留给模型/用户复核（见 pipeline/write.ts 的 decidePlacement）。
// bit2（4）未归类：落位时新建主题但没有候选（远离一切已有主题），写在这里是为了让
//   「这条还没有归属」在库里可查询，而不是只存在于写入返回值里。
// bit3（8）按设计文档留给「已被取代」。**本次不实现、不占位**：被取代关系已经有
//   `superseded_by` 列这个唯一真相源，再补一个位就是两个真相源。
// bit4（16）已归档（T26）：默认不召回，仍可显式检索。它与删除**不是**同一件事 ——
//   归档只改这一位，内容、向量、入口、边都还在库里；取消归档即恢复可见，读路径上的
//   过滤是唯一开关（见 pipeline/archive.ts 的文件头）。

/** 待拆分（bit0，T29）：写入侧按长度切分时置上，确认/忽略时清掉。 */
export const FLAG_SPLIT_PENDING = 1 satisfies ThresholdValue<
  'chosen',
  {
    why: '位定义来自设计报告对 flags 的命名（待拆分 / 歧义 / 未归类），位值一旦落库就不能改；置位判据是长度（review.ts 的 maxChars），不是自洽度评分 —— 候选按长度给出、不判断内容。任何测量都给不出位值'
    failsWhen: ['（不应变：改它等于把历史行解释错）']
    guardedBy: ['test/flags.test.mjs', 'test/split-pending.test.mjs', 'test/client-source.test.mjs']
    affects: 'atom.flags 的 bit0：待拆分（T29）。写入侧**按长度切分**时置上（每段都置），召回时锚行标「疑似应拆分」，由人在界面上确认或忽略（两者都清这一位）'
  }
>

/** 歧义（bit1）：落位时两个候选接近，新建了主题。 */
export const FLAG_AMBIGUOUS = 2 satisfies ThresholdValue<
  'chosen',
  {
    why: '同 FLAG_SPLIT_PENDING：位值不可变 —— bit1 是 flags 的位定义，换掉会把历史行解释错。语义是「落位时两个候选接近、没把握」'
    failsWhen: ['（不应变）']
    guardedBy: ['test/flags.test.mjs', 'test/archive.test.mjs']
    affects: 'atom.flags 的 bit1：落位时两个候选接近、没把握'
  }
>

/** 未归类（bit2）：落位时新建主题且没有候选。 */
export const FLAG_UNCLASSIFIED = 4 satisfies ThresholdValue<
  'chosen',
  {
    why: '同 FLAG_SPLIT_PENDING：位值不可变 —— bit2 是 flags 的位定义，换掉会把历史行解释错。语义是「与任何已有主题都不像」'
    failsWhen: ['（不应变）']
    guardedBy: ['test/flags.test.mjs']
    affects: 'atom.flags 的 bit2：与任何已有主题都不像（未归类）'
  }
>

/** 已归档（bit4，T26）：默认不召回，显式检索仍能看到。 */
export const FLAG_ARCHIVED = 16 satisfies ThresholdValue<
  'chosen',
  {
    why: '位值由设计文档对 flags 的命名确定（技术文档 §5），不可改；bit4 是 flags 的位定义，改它会把历史行解释错。归档不是删除：内容与边都还在，显式检索仍可见'
    failsWhen: ['（不应变）']
    guardedBy: ['test/archive.test.mjs', 'test/client-source.test.mjs']
    affects: 'atom.flags 的 bit4：已归档（T26）。默认不召回、不进注入三段、列表默认不列；显式检索（lattice_list 给 flags、界面勾「显示已归档」）仍可见。不是删除：内容与边都还在'
  }
>
