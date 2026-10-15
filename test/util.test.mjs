import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bigramTerms,
  cjkBigrams,
  estimateTokens,
  extractSummary,
  isCjkChar,
  jaccard,
  shortCjkTerms,
  stripMarkdown,
  textJaccard,
  toSearchColumn,
} from '../dist/util/text.js'
import {
  VEC_BYTES,
  VEC_DIM,
  cosine,
  decodeVec,
  decodeVecCopy,
  dot,
  encodeVec,
  isZeroVec,
  isValidVecBlob,
  l2norm,
  normalizeInPlace,
  normalized,
  zeroVec,
} from '../dist/util/vec.js'

const setEq = (s, arr) => s.size === arr.length && arr.every((x) => s.has(x))
const unitVec = () => {
  const v = new Float32Array(VEC_DIM)
  for (let i = 0; i < VEC_DIM; i++) v[i] = Math.sin(i) * 0.1
  return normalizeInPlace(v)
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

describe('切词', () => {
  it('CJK 整段保留并展开 bigram', () => {
    assert.ok(setEq(bigramTerms('系统代理 v2'), ['系统代理', 'v2', '系统', '统代', '代理']))
  })
  it('单字不产生 bigram', () => assert.deepEqual([...bigramTerms('牛')], ['牛']))
  it('纯符号为空', () => assert.equal(bigramTerms('—— 、。！！').size, 0))
  it('emoji 不影响汉字抽取', () => assert.ok(bigramTerms('记忆 🧠 卡片').has('记忆')))
  it('大小写归一', () => assert.ok(bigramTerms('HTTP2 Server').has('http2')))
  it('汉字判定', () => {
    assert.equal(isCjkChar('记'), true)
    assert.equal(isCjkChar('a'), false)
  })
  it('只取汉字二元组', () => assert.equal(cjkBigrams('a记忆b').join(','), '记忆'))
  it('短词筛选只留 ≤2 字汉字词', () => {
    for (const t of shortCjkTerms('系统代理 v2')) assert.ok(t.length <= 2 && isCjkChar(t[0]))
  })
  it('检索列用空格分隔', () => assert.equal(toSearchColumn(['系统', '代理']), '系统 代理'))
})

describe('摘要与清洗', () => {
  const md = '# 标题\n\n**结论先行**。后面还有\n> 引用段\n- 列表项\n```js\ncode()\n```\n更多内容'
  it('去 Markdown 标记', () => {
    const clean = stripMarkdown(md)
    assert.ok(!clean.includes('#'))
    assert.ok(!clean.includes('**'))
    assert.ok(!clean.includes('```'))
  })
  it('截断到指定长度并带省略号', () => {
    const s = extractSummary('这是一句很长的中文句子'.repeat(8), 48)
    assert.ok(Array.from(s).length <= 48)
    assert.ok(s.endsWith('…'))
  })
  it('优先取第一句', () => assert.equal(extractSummary('短句。第二句不该出现', 48), '短句'))
  it('空输入返回空串', () => assert.equal(extractSummary(''), ''))
  it('按码点截断，不劈开代理对', () => {
    assert.equal(/\uD83D$/.test(extractSummary('🧠'.repeat(30), 21)), false)
  })
  it('token 估算为正数', () => assert.equal(estimateTokens('abcd'), 1))
})

describe('词面相似度', () => {
  it('全同为一', () => assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1))
  it('无交为零', () => assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0))
  it('部分交集', () => assert.ok(close(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3)))
  it('空集不为 NaN', () => assert.equal(jaccard(new Set(), new Set()), 0))
  it('自比为 1', () => assert.equal(textJaccard('系统代理配置', '系统代理配置'), 1))
})

describe('向量编解码', () => {
  it('BLOB 长度为维度乘 4', () => assert.equal(encodeVec(unitVec()).byteLength, VEC_BYTES))
  it('长度校验', () => assert.equal(isValidVecBlob(encodeVec(unitVec())), true))
  it('往返无损', () => {
    const v = unitVec()
    const back = decodeVec(encodeVec(v))
    for (let i = 0; i < VEC_DIM; i++) assert.equal(back[i], v[i])
  })
  it('非 4 字节对齐的 BLOB 也能正确解码', () => {
    const v = unitVec()
    const blob = encodeVec(v)
    const padded = new Uint8Array(blob.byteLength + 3)
    padded.set(blob, 3)
    const misaligned = padded.subarray(3)
    assert.notEqual(misaligned.byteOffset % 4, 0)
    const back = decodeVec(misaligned)
    for (let i = 0; i < VEC_DIM; i++) assert.equal(back[i], v[i])
  })
  it('decodeVecCopy 返回独立副本', () => {
    const blob = encodeVec(unitVec())
    const copy = decodeVecCopy(blob)
    copy[0] = 999
    assert.notEqual(decodeVec(blob)[0], 999)
  })
})

describe('向量运算', () => {
  it('点积与余弦', () => {
    const v = unitVec()
    const neg = new Float32Array(VEC_DIM).map((_, i) => -v[i])
    assert.ok(close(dot(v, v), 1))
    assert.ok(close(l2norm(v), 1))
    assert.ok(close(cosine(v, v), 1))
    assert.ok(close(cosine(v, neg), -1))
  })
  it('零向量余弦为零', () => assert.equal(cosine(unitVec(), zeroVec()), 0))
  it('零向量判定', () => {
    assert.equal(isZeroVec(zeroVec()), true)
    assert.equal(isZeroVec(unitVec()), false)
  })
  it('normalized 不修改入参', () => {
    const raw = new Float32Array(VEC_DIM).fill(2)
    const n = normalized(raw)
    assert.equal(raw[0], 2)
    assert.ok(close(l2norm(n), 1))
  })
})
