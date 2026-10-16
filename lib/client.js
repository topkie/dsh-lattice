// dsh-lattice — 浏览器半（记忆管理界面）。
//
// 这个文件是**手写的发布产物**，不是构建输出。宿主按 package.json 的 exports["./client"]
// 把它的字节原样读出来送进页面（见 dsh-client-modules 的 clientExportOf），所以这里直接写
// window.__ModuleLoader__.load({ id, factory })，不引入任何前端构建链：不需要打包器、
// 不需要 JSX、不需要 React 的 npm 包 —— React 由宿主的平台模块表提供。
//
// 它兑现的是设计报告 §43 的「界面」那一节：**能判断该管哪条**。四件事里做了三件 ——
//   列表（库里有什么）、搜索（定位到某一条）、归属显示（谁写的 / 取回几次 / 是否被取代）。
// 第四件「删除入口」是 T20：那个权限的落点是它，但语义（软删 / 留痕 / 防写回）还没设计。
//
// 刻意**不做**的（§43 的「不做」表）：不主动推送（无未读标记、无角标、无弹窗）、
// 不做健康面板、不做编辑、不做多 scope 管理。所以这里没有任何定时器与轮询 ——
// 取数只发生在挂载、翻页、改筛选、点搜索、点刷新这五种动作上。
//
// 数据全部来自宿主半的三条只读路由（src/index.ts 里的路径常量）。两侧各写一遍是有意的：
// 浏览器半是发布产物，不参与 tsc，也不 import 宿主半的任何东西。改一边就要改另一边。

window.__ModuleLoader__.load({
  id: 'dsh-lattice',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    /** 库的规模（座位验证留下的那条基线路由，也用来显示版本）。 */
    const PING_URL = '/api/lattice-ping-mini'
    /** 目录：分页 + 过滤。 */
    const ATOMS_URL = '/api/lattice-atoms'
    /** 搜索：一条查询进，若干条命中出。 */
    const SEARCH_URL = '/api/lattice-search'

    /** 设置页导航里这一项的文字。 */
    const SECTION_LABEL = '记忆管理'

    /** 来源过滤的选项。取值与库里的 origin 字段一致（值在左，人话在右）。 */
    const ORIGINS = [
      ['', '全部来源'],
      ['user', '用户'],
      ['model', '模型'],
      ['import', '导入'],
    ]

    const CSS = [
      '.lattice-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 10px; }',
      '.lattice-bar { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; flex-wrap: wrap; }',
      '.lattice-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.lattice-status { font-size: 12px; color: var(--dsw-alias-label-primary); }',
      '.lattice-status-bad { color: var(--dsw-alias-state-error-primary); }',
      '.lattice-btn { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }',
      '.lattice-btn:disabled { color: var(--dsw-alias-label-secondary); cursor: default; }',
      '.lattice-select, .lattice-input { font-size: 12px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }',
      '.lattice-input { min-width: 220px; }',
      '.lattice-rows { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }',
      '.lattice-row { padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }',
      '.lattice-row:last-child { border-bottom: none; }',
      '.lattice-row-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; }',
      '.lattice-id { color: var(--dsw-alias-label-secondary); }',
      '.lattice-mark { color: var(--dsw-alias-label-secondary); }',
      '.lattice-scope { color: var(--dsw-alias-label-secondary); }',
      '.lattice-summary { font-size: 13px; color: var(--dsw-alias-label-primary); margin-top: 2px; word-break: break-word; }',
      '.lattice-time { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }',
      // 已被取代的行压暗一档：它还在库里，但通常不是该管的那条 —— 这是「该管哪条」的一半。
      '.lattice-row-superseded { opacity: 0.55; }',
      '.lattice-pager { display: flex; align-items: center; gap: 8px; margin: 10px 0; }',
      '.lattice-results { margin-top: 14px; }',
    ].join('\n')

    const CSS_TAG_ID = 'dsh-lattice/ui.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-lattice'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 取一次宿主半的只读路由。任何失败都变成可显示的一份结果，不抛给渲染层。 */
    async function getJson(url) {
      try {
        const response = await fetch(url)
        const text = await response.text()
        let data = null
        try {
          data = JSON.parse(text)
        } catch {
          data = null
        }
        if (!response.ok || data === null) {
          return { ok: false, status: response.status, error: 'HTTP ' + response.status + '：' + text.slice(0, 300) }
        }
        return data
      } catch (error) {
        return { ok: false, status: 0, error: String(error && error.message ? error.message : error) }
      }
    }

    /**
     * 目录请求的 URL。
     *
     * 不传 limit：页大小由宿主半的 LIST_DEFAULT_LIMIT 定，响应里把它原样带回来，
     * 翻页按那个数走 —— 前端自己写一个页大小，两侧就会各自漂移。
     */
    function atomsUrl(offset, origin, scope) {
      const parts = ['offset=' + offset]
      if (origin !== '') parts.push('origin=' + encodeURIComponent(origin))
      if (scope !== '') parts.push('scope=' + encodeURIComponent(scope))
      return ATOMS_URL + '?' + parts.join('&')
    }

    function searchUrl(query, scope) {
      const parts = ['q=' + encodeURIComponent(query)]
      if (scope !== '') parts.push('scope=' + encodeURIComponent(scope))
      return SEARCH_URL + '?' + parts.join('&')
    }

    /** 所有权的可读说法 —— 与工具 lattice_list 用的是同一套词。 */
    function originLabel(o) {
      if (o === 'user') return '用户'
      if (o === 'import') return '导入'
      return '模型'
    }

    /**
     * 归属标记：谁写的 / 是否已被取代 / 被取回几次。
     *
     * 三项缺一，列表就退回「一堆等权文本」（§43 的原话）—— 所以它们是这一行里最不该省的部分。
     */
    function marks(row) {
      const parts = [originLabel(row.origin)]
      if (row.supersededBy !== null && row.supersededBy !== undefined) {
        parts.push('已被 #' + row.supersededBy + ' 取代')
      }
      if (row.recallHits > 0) parts.push('取回 ' + row.recallHits + ' 次')
      return parts.join('·')
    }

    function pad(n) {
      return n < 10 ? '0' + n : String(n)
    }

    /** 毫秒时间戳 → 本地时间。取不到就返回空串（渲染时整行不出现）。 */
    function when(ts) {
      if (ts === null || ts === undefined || ts <= 0) return ''
      const d = new Date(ts)
      return (
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      )
    }

    /** 目录/搜索共用的一行渲染。superseded 的行压暗一档。 */
    function renderRow(row, scopeOn) {
      const superseded = row.supersededBy !== null && row.supersededBy !== undefined
      const head = [
        React.createElement('span', { className: 'lattice-id', key: 'id' }, '#' + row.id),
        React.createElement('span', { className: 'lattice-mark', key: 'marks' }, '[' + (row.kind || '-') + '·' + marks(row) + ']'),
      ]
      if (scopeOn && row.scope && row.scope !== 'global') {
        head.push(React.createElement('span', { className: 'lattice-scope', key: 'scope' }, '{' + row.scope + '}'))
      }
      const body = [
        React.createElement('div', { className: 'lattice-row-head', key: 'head' }, head),
        React.createElement('div', { className: 'lattice-summary', key: 'summary' }, row.summary),
      ]
      const last = when(row.lastRecalledAt)
      if (last !== '') {
        body.push(React.createElement('div', { className: 'lattice-time', key: 'time' }, '最后取回 ' + last))
      }
      return React.createElement(
        'div',
        { className: superseded ? 'lattice-row lattice-row-superseded' : 'lattice-row', key: 'r' + row.id },
        body,
      )
    }

    function MemoryManager() {
      const [ping, setPing] = React.useState(null)
      const [origin, setOrigin] = React.useState('')
      const [scope, setScope] = React.useState('')
      const [offset, setOffset] = React.useState(0)
      const [page, setPage] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [found, setFound] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        getJson(PING_URL).then((value) => {
          if (alive) setPing(value)
        })
        return () => {
          alive = false
        }
      }, [nonce])

      // 目录：挂载、翻页、改筛选、点刷新时才取。没有轮询 —— 界面是「用户想起来才打开」的。
      React.useEffect(() => {
        let alive = true
        getJson(atomsUrl(offset, origin, scope)).then((value) => {
          if (alive) setPage(value)
        })
        return () => {
          alive = false
        }
      }, [offset, origin, scope, nonce])

      function runSearch() {
        const q = query.trim()
        if (q === '') {
          setFound(null)
          return
        }
        setBusy(true)
        getJson(searchUrl(q, scope)).then((value) => {
          setFound(value)
          setBusy(false)
        })
      }

      const listed = page !== null && page.ok === true
      const rows = listed ? page.rows : []
      const total = listed ? page.total : 0
      // 服务端回什么页大小就用什么 —— 前端不另立一个数（见 atomsUrl 的注释）。
      const limit = listed && page.limit > 0 ? page.limit : rows.length || 1
      const pageNo = Math.floor(offset / limit) + 1
      const pageCount = Math.max(1, Math.ceil(total / limit))

      const children = [
        React.createElement(
          'p',
          { className: 'lattice-hint', key: 'hint' },
          '这里能看、能搜，不能改。判断该管哪条靠每行的来源、取回次数与取代标记；删除入口属于下一步（T20），本版不提供。',
        ),
      ]

      let statusText = '读取中…'
      if (page !== null) {
        if (listed) {
          statusText = '共 ' + total + ' 条' + (ping !== null && ping.ok === true ? ' · v' + ping.version : '')
        } else {
          statusText = '读取失败：' + String(page.error || '未知错误')
        }
      }
      children.push(
        React.createElement(
          'div',
          { className: 'lattice-bar', key: 'status' },
          React.createElement(
            'span',
            { className: page !== null && !listed ? 'lattice-status lattice-status-bad' : 'lattice-status' },
            statusText,
          ),
          React.createElement('button', { className: 'lattice-btn', onClick: () => setNonce(nonce + 1) }, '刷新'),
        ),
      )

      children.push(
        React.createElement(
          'div',
          { className: 'lattice-bar', key: 'filters' },
          React.createElement('span', { className: 'lattice-label' }, '来源'),
          React.createElement(
            'select',
            {
              className: 'lattice-select',
              value: origin,
              onChange: (event) => {
                setOrigin(event.target.value)
                setOffset(0)
              },
            },
            ORIGINS.map(([value, text]) => React.createElement('option', { key: value, value: value }, text)),
          ),
          React.createElement('span', { className: 'lattice-label' }, '范围'),
          React.createElement('input', {
            className: 'lattice-input',
            placeholder: '留空＝全部；填项目键＝该项目 + 全局',
            value: scope,
            onChange: (event) => {
              setScope(event.target.value)
              setOffset(0)
            },
          }),
        ),
      )

      const rowNodes = []
      if (listed) {
        if (rows.length === 0) {
          rowNodes.push(React.createElement('p', { className: 'lattice-hint', key: 'empty' }, '没有符合条件的记忆。'))
        }
        for (const row of rows) rowNodes.push(renderRow(row, true))
        children.push(React.createElement('div', { className: 'lattice-rows', key: 'rows' }, rowNodes))
        children.push(
          React.createElement(
            'div',
            { className: 'lattice-pager', key: 'pager' },
            React.createElement(
              'button',
              {
                className: 'lattice-btn',
                disabled: offset <= 0,
                onClick: () => setOffset(Math.max(0, offset - limit)),
              },
              '上一页',
            ),
            React.createElement(
              'span',
              { className: 'lattice-status' },
              '第 ' + pageNo + ' / ' + pageCount + ' 页',
            ),
            React.createElement(
              'button',
              {
                className: 'lattice-btn',
                disabled: offset + rows.length >= total,
                onClick: () => setOffset(offset + limit),
              },
              '下一页',
            ),
          ),
        )
      }

      children.push(
        React.createElement(
          'div',
          { className: 'lattice-bar', key: 'search' },
          React.createElement('input', {
            className: 'lattice-input',
            placeholder: '搜索记忆（回车）',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') runSearch()
            },
          }),
          React.createElement('button', { className: 'lattice-btn', disabled: busy, onClick: runSearch }, busy ? '搜索中…' : '搜索'),
        ),
      )

      if (found !== null) {
        const hitOk = found.ok === true
        const hits = hitOk ? found.hits : []
        const hitNodes = [
          React.createElement(
            'p',
            { className: hitOk ? 'lattice-hint' : 'lattice-hint lattice-status-bad', key: 'found' },
            hitOk
              ? '命中 ' + hits.length + ' 条' + (found.meta && found.meta.vectorMissing === true ? '（编码器不可用，本次为纯词面搜索）' : '')
              : '搜索失败：' + String(found.error || '未知错误'),
          ),
        ]
        for (const hit of hits) hitNodes.push(renderRow(hit, true))
        children.push(React.createElement('div', { className: 'lattice-results', key: 'results' }, hitNodes))
      }

      return React.createElement('div', { className: 'lattice-panel' }, children)
    }

    function apply(ctx) {
      // inject 而不是 register：settings.section 由设置外壳的 children 表声明，
      // 声明可能晚于本插件加载，所以等它出现再注册。
      ctx.effect(() => {
        return ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'lattice-memory',
              order: 40,
              label: () => SECTION_LABEL,
            },
            MemoryManager,
          ),
        )
      }, 'dsh-lattice: settings section')
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
