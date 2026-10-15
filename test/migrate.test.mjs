// 迁移切分测试。纯函数，不碰库、不碰网络。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  draftAtoms,
  MAX_ATOM_CHARS,
  MIN_ATOM_CHARS,
  splitBySentence,
  splitSections,
} from '../dist/migrate/split.js'

describe('切分：按 H2 分节', () => {
  it('按 H2 切开，每节含标题行', () => {
    const text = ['# 标题', '', '开头一段结论。', '', '## 甲', '甲的内容。', '', '## 乙', '乙的内容。'].join(
      '\n',
    )
    const secs = splitSections(text)
    assert.equal(secs.length, 3)
    assert.equal(secs[0].heading, '', '引言块 heading 为空')
    assert.ok(secs[0].body.includes('开头一段结论'))
    assert.equal(secs[1].heading, '甲')
    assert.ok(secs[1].body.startsWith('## 甲'), '正文保留标题行，便于校验原样可见')
  })

  it('无 H2 时整卡作为一节', () => {
    const secs = splitSections('只有一段话，没有任何二级标题。')
    assert.equal(secs.length, 1)
    assert.equal(secs[0].heading, '')
  })

  it('空文本产出零节', () => {
    assert.deepEqual(splitSections('   '), [])
  })

  it('三级标题不算分节边界', () => {
    const text = ['## 甲', '内容一。', '### 甲的子标题', '内容二。'].join('\n')
    const secs = splitSections(text)
    assert.equal(secs.length, 1)
    assert.ok(secs[0].body.includes('子标题'))
  })
})

describe('切分：长度修正', () => {
  it('过短的小节被并入后一节', () => {
    const short = '很短。'
    assert.ok(short.length < MIN_ATOM_CHARS)
    const text = ['## 甲', short, '## 乙', '乙的内容，' + '补充说明。'.repeat(20)].join('\n')
    const drafts = draftAtoms('card.md', text)
    assert.equal(drafts.length, 1, '短节应当被合并掉')
    assert.ok(drafts[0].text.includes('很短。'), '合并后短节内容仍在')
    assert.ok(drafts[0].text.includes('乙的内容'), '且与后一节在一起')
  })

  it('过长的小节按句子边界再切，且每块不超上界', () => {
    const long = '这是一个长句子，用来把内容撑长。'.repeat(60)
    assert.ok(long.length > MAX_ATOM_CHARS)
    const drafts = draftAtoms('card.md', '## 长节\n' + long)
    assert.ok(drafts.length > 1, '过长节应当被切开')
    for (const d of drafts) {
      assert.ok(d.text.length <= MAX_ATOM_CHARS, '超过上界: ' + d.text.length)
    }
  })

  it('单句超长时按长度硬切，保证上界不被突破', () => {
    const oneSentence = '甲'.repeat(MAX_ATOM_CHARS * 2 + 50) // 没有任何句末标点
    const pieces = splitBySentence(oneSentence)
    assert.ok(pieces.length >= 3)
    for (const p of pieces) assert.ok(p.length <= MAX_ATOM_CHARS)
  })

  it('切分不丢内容：所有原文片段都能在草稿里找到', () => {
    const text = [
      '# 卡标题',
      '引言段，说明这张卡讲什么。'.repeat(6),
      '## 甲',
      '甲的内容。'.repeat(30),
      '## 极短',
      '短。',
      '## 乙',
      '乙的内容。'.repeat(40),
    ].join('\n')
    const drafts = draftAtoms('card.md', text)
    const joined = drafts.map((d) => d.text).join('\n')
    // 除了被切断的空白，原卡的每个非空行都应能在草稿中找到。
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      assert.ok(joined.includes(line.trim()), '丢失内容: ' + line.slice(0, 30))
    }
  })

  it('每个草稿都记录来源路径与标题', () => {
    const drafts = draftAtoms('08-Mistakes/x.md', '## 甲\n' + '内容。'.repeat(40))
    assert.equal(drafts[0].sourcePath, '08-Mistakes/x.md')
    assert.deepEqual(drafts[0].headings, ['甲'])
  })
})
