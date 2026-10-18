// 推断边统计的口径探针：声明边与推断边撞唯一键时，stats 报的是「待插入」还是「实际插入」。
//
// 装置：两条向量完全相同的 atom，其中一条带一条**声明**的 near 边（方向与推断方向相反）。
// 全量重建时，那条声明边占住了唯一键，推断的那一行被 DO NOTHING 跳过 ——
// 于是「待插入的 near 边」比「表里真实存在的 inferred 边」多 1 条。
//
// 用法：node scripts/probe-infer-stats.mjs
// 期望：stats.nearEdges 与表内 origin = inferred 的行数一致。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { DUP_COS, DUP_LEX } from '../dist/pipeline/search.js'
import { inferEdges } from '../dist/graph/infer.js'

const dir = mkdtempSync(join(tmpdir(), 'infer-stats-'))
const db = openVault(join(dir, 'lattice.db')).db
const v = new Float32Array(VEC_DIM)
v[0] = 1
const encode = async () => v
const ctx = createWriteCtx(db, {}, { encode })
const a = (await writeAtom(ctx, { text: '甲条：用来构造声明边与推断边撞键的装置。' })).atomId
const b = (
  await writeAtom(ctx, {
    text: '乙条：与甲条向量相同，声明一条 near 边指向甲条。',
    edges: [{ type: 'near', target: a }],
  })
).atomId
const countOf = (where) => Number(db.prepare('SELECT COUNT(*) AS n FROM edge WHERE ' + where).get().n)
console.log('atom id：甲=' + a + ' 乙=' + b)
console.log(
  '重建前：声明边 ' +
    countOf("origin = 'declared'") +
    ' 行，inferred 边 ' +
    countOf("origin = 'inferred'") +
    ' 行',
)
const out = inferEdges(db, { dupCos: DUP_COS, dupLex: DUP_LEX })
console.log(
  'stats：nearEdges = ' +
    out.stats.nearEdges +
    '，duplicateEdges = ' +
    out.stats.duplicateEdges +
    '，maxOutDegree = ' +
    out.stats.maxOutDegree +
    '，meanOutDegree = ' +
    out.stats.meanOutDegree +
    '，isolatedAtoms = ' +
    out.stats.isolatedAtoms,
)
console.log('重建后：表内 origin = inferred 的行数 = ' + countOf("origin = 'inferred'"))
console.log('重建后：表内 origin = declared 的行数 = ' + countOf("origin = 'declared'"))
db.close()
rmSync(dir, { recursive: true, force: true })
