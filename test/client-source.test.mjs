// 浏览器半与宿主半的**源码级**对照（A9）。
//
// 浏览器半（lib/client.js）是手写的发布产物：不参与 tsc、不 import 宿主半的任何东西，
// 所以位值与路由路径在两侧各写一遍。写错了不会有编译错误 —— 只会「界面点了没反应」，
// 或者位掩码对不上、归档状态在界面上永远不显示。
//
// 这里读两边的**源码文本**逐值对照。为什么不断言运行时：浏览器半根本不在 Node 里执行
// （它调 window.__ModuleLoader__），运行时要造一个宿主环境，那测的就不是这份字节了。
//
// 与界面用例同一条理由：形状上写死的东西，只能在源码层面钉住。

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
    // 十七条路由全部列出，不抽样：任何一条写错的形态都是「界面点了没反应」或
    // 「永远 404」，浏览器里没有编译期信号，只能在这里钉住。少列一条就等于
    // 那条路由没被检查。
    const pairs = [
      // 读数与列表
      ['PING_URL', 'MINI_ROUTE_PATH'],
      ['ATOMS_URL', 'ATOMS_ROUTE_PATH'],
      ['AUDIT_URL', 'AUDIT_ROUTE_PATH'],
      // 详情：界面点开时取全文的那条路由。路径写错的形态是「点开永远 404」，
      // 而这在浏览器里只表现为一段「读取失败」，不会有任何编译期信号。
      ['ATOM_DETAIL_URL', 'ATOM_ROUTE_PATH'],
      ['SEARCH_URL', 'SEARCH_ROUTE_PATH'],
      // 写动作
      ['FORGET_URL', 'FORGET_ROUTE_PATH'],
      ['ARCHIVE_URL', 'ARCHIVE_ROUTE_PATH'],
      ['UNARCHIVE_URL', 'UNARCHIVE_ROUTE_PATH'],
      ['SPLIT_CONFIRM_URL', 'SPLIT_CONFIRM_ROUTE_PATH'],
      ['SPLIT_IGNORE_URL', 'SPLIT_IGNORE_ROUTE_PATH'],
      ['RECLUSTER_PLAN_URL', 'RECLUSTER_PLAN_ROUTE_PATH'],
      ['RECLUSTER_CANCEL_URL', 'RECLUSTER_CANCEL_ROUTE_PATH'],
      ['LEARNED_CLEAR_URL', 'LEARNED_CLEAR_ROUTE_PATH'],
      ['LOG_CLEAR_URL', 'LOG_CLEAR_ROUTE_PATH'],
      // 配置：路径写错的形态是「配置页永远说读不到可改字段」，同样没有编译期信号。
      ['CONFIG_URL', 'CONFIG_ROUTE_PATH'],
      // 两条导出：路径写错的形态是「点了按钮下载一份 404 页面」，浏览器里同样没有信号。
      ['LOG_EXPORT_URL', 'LOG_EXPORT_ROUTE_PATH'],
      ['EXPORT_URL', 'EXPORT_ROUTE_PATH'],
    ]
    for (const [clientName, hostName] of pairs) {
      assert.equal(
        stringOf(client, clientName),
        stringOf(host, hostName),
        clientName + ' 与 ' + hostName + ' 不同值',
      )
    }
  })

  // 配置表单有两条形状上的约束，写错了不会有任何编译错误，只会「点了没反应」或「改的是空气」：
  // ① 保存请求必须带 confirm（宿主半的写端点一律要求，缺了就是 400 no-confirm）；
  // ② 必须把 revision 一起发出去（宿主的乐观锁，不传等于放弃「你改的时候别人没改过」这条检查）。
  it('配置表单：保存请求带 confirm 与 revision，字段解析认 dict 与 refs', () => {
    assert.match(client, /function configFields\(/, '浏览器半里没有 configFields：宿主返回的字段形状没人解析')
    assert.match(client, /root\.dict !== undefined/, 'configFields 不再认根节点的 dict：宿主实测形状就是这样')
    assert.match(client, /confirm: true/, '保存请求没带 confirm，宿主会直接拒')
    assert.match(client, /revision: revision/, '保存请求没带 revision，宿主的乐观锁形同虚设')
    // 字段清单只能来自宿主：写死一份字段名，宿主改配置后界面就会列出不存在的项。
    assert.match(client, /fields\.map\(/, '配置表单没有遍历宿主给出的字段，清单被写死了')
  })

  /**
   * 保存之后界面显示旧值，用户看到的是「保存失败」—— 这条踩过一次（2026-10-24 实测）。
   *
   * 三条约束都不报编译错，只让输入框弹回：
   * ① 宿主把更新后的那一条随响应带回来了，直接用它，不要再打一次 GET；
   * ② 真要重读就带 no-store，缓存住一次就是显示一个已经不成立的数字；
   * ③ 读数卡片取的是另一条路由（ping-mini），它只跟 nonce 变，保存后必须通知父级刷新。
   */
  it('配置表单：保存后用响应里的新值，并让父级重取读数', () => {
    assert.match(
      client,
      /result\.entry !== null/,
      '保存后没用响应里的 entry：界面只能再取一次，而再取一次可能拿到旧值',
    )
    assert.match(client, /setData\(\{ \.\.\.data, entry: result\.entry \}\)/, '响应里的 entry 没被当成新基线')
    assert.match(
      client,
      /getJson\(CONFIG_URL, \{ cache: 'no-store' \}\)/,
      '读配置没带 no-store：浏览器缓存住一次读数，保存后就会弹回旧值',
    )
    assert.match(
      client,
      /if \(typeof props\.onSaved === 'function'\) props\.onSaved\(\)/,
      '保存后没通知父级：上面的「注入预算」读数会一直是保存前的数',
    )
  })

  /**
   * 导出按钮：两个格式各一条，都走同一只读路由，格式只放在查询串里。
   *
   * 写错的形态是「点了没反应」或「两个按钮下到同一份文件」—— 浏览器里都没有信号，
   * 只有点下去的人会发现。所以这里钉住三件事：请求确实走 EXPORT_URL、format 有两个取值、
   * 下载不是 window.open（宿主渲染进程不放行新窗口，点了既不下载也不报错）。
   */
  it('导出按钮：两种格式各走一次路由，格式只在查询串里', () => {
    assert.match(
      client,
      /downloadFile\(EXPORT_URL \+ '\?format=' \+ format, fallback\)/,
      '导出按钮没走 EXPORT_URL 或没走下载助手：换成别的路径只会下到一份 404 页面',
    )
    for (const format of ['json', 'md']) {
      assert.match(client, new RegExp("onExport\\('" + format + "'\\)"), '导出少了一个格式按钮：' + format)
    }
    assert.match(
      client,
      /configKids\.push\(exportPanel\(exportMemory\)\)/,
      '导出界面没接上动作：按钮点了不会有任何请求',
    )
    assert.doesNotMatch(
      client,
      /window\.open\(/,
      '导出又用回了 window.open：宿主渲染进程不放行新窗口，点了没反应也没报错',
    )
  })
})
