import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './dist/index.js'
import { closeRuntime, runtimeEncode } from './dist/state.js'

const dir = mkdtempSync(join(tmpdir(), "dbgt8-"))
const cfg = { enabled: true, dataDir: dir, encoderEnabled: true, encoderModel: "Xenova/bge-small-zh-v1.5", encoderMirror: "", encoderCacheDir: "", tauJoin: 0.78, tauLex: 0.05, tauLexOnly: 0.1, tauNew: 0.5, viewBudget: 6000, topN: 24, mmapSize: 0, cacheSize: 0, busyTimeout: 0 }
const reg = []
apply({ get: (k) => (k === "tools" ? { register: (t) => reg.push(t) } : undefined) }, cfg)
const v = await runtimeEncode(cfg, "代理")
console.log("runtimeEncode 返回:", v === null ? "null（应为纯词面）" : "向量 length=" + v.length)
const w = reg.find((t) => t.name === "lattice_write")
await w.execute({ text: "系统代理必须走本地端口。" })
const r = reg.find((t) => t.name === "lattice_recall")
const out = await r.execute({ query: "代理" })
console.log("召回输出首行:", out.split(String.fromCharCode(10))[0])
console.log("是否含纯词面:", out.includes("纯词面"))
closeRuntime()