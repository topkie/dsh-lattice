// 浏览器半与宿主半的**源码级**对照（A9）。
//
// 浏览器半（lib/client.js）是手写的发布产物：不参与 tsc、不 import 宿主半的任何东西，
// 所以位值与路由路径在两侧各写一遍。写错了不会有编译错误 —— 只会「界面点了没反应」，
// 或者位掩码对不上、归档状态在界面上永远不显示。
//
// 这里读两边的**源码文本**逐值对照。为什么不断言运行时：浏览器半根本不在 Node 里执行
// （它调 window.__ModuleLoader__），运行时要造一个宿主环境，那测的就不是这份字节了。
//
// 与 T29 的界面用例同一条理由：形状上写死的东西，只能在源码层面钉住。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { FLAG_ARCHIVED, FLAG_SPLIT_PENDING } from '../dist/db/flags.js'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** 取 `名字 = '字面量'` 的右值（单引号字符串）。 */
function stringOf(src, name) {
  const m = new RegExp('const ' + name + " = '([^']+)'").exec(src)
  assert.ok(m !== null, '源码里找不到 ' + name + ' 的字符串字面量')
  return m[1]
}

/** 取 `名字 = 数字` 的右值。 */
function numberOf(src, name) {
  const m = new RegExp('const ' + name + ' = (\\d+)').exec(src)
  assert.ok(m !== null, '源码里找不到 ' + name + ' 的数字字面量')
  return Number(m[1])
}

describe('浏览器半与宿主半的常量对照（源码级）', () => {
  it('位值：client.js 的归档位与待拆位等于 src 导出的常量', () => {
    assert.equal(numberOf(client, 'FLAG_ARCHIVED'), FLAG_ARCHIVED, '归档位对不上：界面会把别的位当归档')
    assert.equal(
      numberOf(client, 'FLAG_SPLIT_PENDING'),
      FLAG_SPLIT_PENDING,
      '待拆位对不上：界面会漏掉或错标待拆分候选',
    )
  })

  it('路由：新路径两侧同值', () => {
    const pairs = [
      // 详情：界面点开时取全文的那条路由。路径写错的形态是「点开永远 404」，
      // 而这在浏览器里只表现为一段「读取失败」，不会有任何编译期信号。
      ['ATOM_DETAIL_URL', 'ATOM_ROUTE_PATH'],
      ['ARCHIVE_URL', 'ARCHIVE_ROUTE_PATH'],
      ['UNARCHIVE_URL', 'UNARCHIVE_ROUTE_PATH'],
      ['SPLIT_CONFIRM_URL', 'SPLIT_CONFIRM_ROUTE_PATH'],
      ['SPLIT_IGNORE_URL', 'SPLIT_IGNORE_ROUTE_PATH'],
    ]
    for (const [clientName, hostName] of pairs) {
      assert.equal(
        stringOf(client, clientName),
        stringOf(host, hostName),
        clientName + ' 与 ' + hostName + ' 不同值',
      )
    }
  })
})
