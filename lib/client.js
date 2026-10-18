// dsh-lattice — 浏览器半（记忆管理界面）。
//
// 这个文件是**手写的发布产物**，不是构建输出。宿主按 package.json 的 exports["./client"]
// 把它的字节原样读出来送进页面（见 dsh-client-modules 的 clientExportOf），所以这里直接写
// window.__ModuleLoader__.load({ id, factory })，不引入任何前端构建链：不需要打包器、
// 不需要 JSX、不需要 React 的 npm 包 —— React 由宿主的平台模块表提供。
//
// 它兑现的是设计报告 §43 的「界面」那一节：**能判断该管哪条**。外加两件与降级日志有关的事：
//   列表（库里有什么）、搜索（定位到某一条）、归属显示（谁写的 / 取回几次 / 是否被取代）、
//   **删除**（T20，§44）、**导出日志 / 清空日志**（M4-T44，见日志模块草案第十、十一节）。
//
// 删除是**唯一**的写动作，也是整个插件唯一的写入口（§11.1：物理删除归用户，模型只能
// 提议）。两件刻意不做的事：
//   - **不加二次确认**：用户点删除 = 完整授权（§43）。过闸的对象是**模型的操作**，
//     而模型根本没有删除这个动作可用；对一个已经表达完整意图的人再问一遍，
//     只是把「确认」变成一次点击仪式。
//   - **不做回收站 / 恢复**：那会把「删除」降级成「暂时挪开」，而判据要的是「用户删除
//     的内容不会被重新写入」—— 一个能被用户自己撤销的删除与该判据的语义不符。
//
// 删除成功后立刻重取列表：没有乐观更新。少一份「前端以为删掉了、后端其实没有」的状态
// 空间，代价是一次请求。
//
// 刻意**不做**的（§43 的「不做」表）：不主动推送（无未读标记、无角标、无弹窗）、
// 不做健康面板、不做编辑、不做多 scope 管理。所以这里没有任何定时器与轮询 ——
// 取数只发生在挂载、翻页、改筛选、点搜索、点刷新这五种动作上。
//
// 数据来自宿主半的四条路由（三条只读 + 一条写，见 src/index.ts 里的路径常量）。两侧各写
// 一遍是有意的：
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
    /** 删除：写端点。与宿主半 src/index.ts 的 FORGET_ROUTE_PATH 必须同值。 */
    const FORGET_URL = '/api/lattice-forget'
    /** 导出降级日志：只读路由，响应是 CSV 附件。与 LOG_EXPORT_ROUTE_PATH 必须同值。 */
    const LOG_EXPORT_URL = '/api/lattice-log-export'
    /** 清空降级日志：写端点，要求 { confirm: true }。与 LOG_CLEAR_ROUTE_PATH 必须同值。 */
    const LOG_CLEAR_URL = '/api/lattice-log-clear'

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
      // 删除按钮靠右、常态低调：它是**唯一**的写动作，不该在一屏里最显眼。
      '.lattice-head-right { margin-left: auto; }',
      '.lattice-del { font-size: 11px; padding: 1px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }',
      '.lattice-del:hover { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.lattice-ok { font-size: 12px; color: var(--dsw-alias-label-primary); }',
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

    /**
     * POST 一个 JSON 给宿主半的**写**路由。与 getJson 同一条纪律：任何失败都变成可显示的
     * 一份结果，不抛给渲染层。
     *
     * content-type 必须显式写出来：宿主半的写端点要求 application/json（挡跨站简单请求），
     * 而 fetch 的默认 content-type 取决于 body 的类型 —— 不写就会被 415 挡回来。
     */
    async function postJson(url, body) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const text = await response.text()
        let data = null
        try {
          data = JSON.parse(text)
        } catch {
          data = null
        }
        if (!response.ok || data === null) {
          const why = data && data.message ? data.message : text.slice(0, 300)
          return { ok: false, status: response.status, error: 'HTTP ' + response.status + '：' + why }
        }
        return data
      } catch (error) {
        return { ok: false, status: 0, error: String(error && error.message ? error.message : error) }
      }
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

    /**
     * 目录/搜索共用的一行渲染。superseded 的行压暗一档。
     *
     * 第三参 `onForget` 给了才画删除按钮。为什么要能不给：搜索结果与目录是两份数据，
     * 但删除是同一件事 —— 让搜索结果也带按钮，用户就不必「先搜到、再去目录里找回来」。
     */
    function renderRow(row, scopeOn, onForget) {
      const superseded = row.supersededBy !== null && row.supersededBy !== undefined
      const head = [
        React.createElement('span', { className: 'lattice-id', key: 'id' }, '#' + row.id),
        React.createElement('span', { className: 'lattice-mark', key: 'marks' }, '[' + (row.kind || '-') + '·' + marks(row) + ']'),
      ]
      if (scopeOn && row.scope && row.scope !== 'global') {
        head.push(React.createElement('span', { className: 'lattice-scope', key: 'scope' }, '{' + row.scope + '}'))
      }
      if (typeof onForget === 'function') {
        // 按钮上写「删除」而不是图标：这个动作没有撤销，凡是不可撤销的动作都该把话说全。
        head.push(
          React.createElement(
            'button',
            {
              className: 'lattice-del lattice-head-right',
              key: 'del',
              onClick: () => onForget(row),
            },
            '删除',
          ),
        )
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
      /** 刚才那次删除的结果（成功或失败都要说给用户听）。 */
      const [notice, setNotice] = React.useState(null)

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

      /**
       * 删除一条记忆。
       *
       * 没有二次确认（§43）：用户点删除 = 完整授权。过闸的对象是**模型的操作** ——
       * 而模型根本没有这个动作可用（lattice_forget 不在模型可见的工具表里）。
       *
       * 删完立刻重取目录、并清掉过期的搜索结果：不乐观更新，也不留一份「看起来还在、
       * 其实已经不在」的命中列表。
       */
      function forget(row) {
        setNotice({ ok: null, text: '正在删除 #' + row.id + '…' })
        postJson(FORGET_URL, { atom_id: row.id }).then((value) => {
          if (value.ok === true) {
            const again = value.alreadyForgotten === true ? '（这条之前已删过）' : ''
            setNotice({
              ok: true,
              text:
                '已删除 #' + value.atomId + '「' + String(value.summary || '').slice(0, 40) + '」' +
                again +
                ' · 内容指纹 ' + String(value.tombstoneId) + ' 号墓碑已留痕，同样的内容不会再被写入',
            })
          } else {
            setNotice({ ok: false, text: '删除失败：' + String(value.error || '未知错误') })
          }
          setFound(null)
          setNonce(nonce + 1)
        })
      }

      /**
       * 导出日志：直接打开只读路由。
       *
       * 响应带 Content-Disposition: attachment，浏览器会存成文件而不是渲染成页面；
       * 也不在前端把整份 CSV 拼出来再下载 —— 那等于让页面持有全部日志内容。
       */
      function exportLogs() {
        window.open(LOG_EXPORT_URL, '_blank')
      }

      /**
       * 清空日志：**二次确认**，只弹确认框。
       *
       * 不要求输入文字、不提示先导出（用户裁决：删除由用户主动发出，用户对后果负责；
       * 确认框写清「不可撤销」已经尽到提醒义务）。真正的写栅栏在宿主半：
       * 非 POST / 非 application/json / 没带 { confirm: true } 都会被拒。
       */
      function clearLogs() {
        const sure = window.confirm(
          '清空降级日志？此操作不可撤销：当前与历史日志文件都会被删除，记忆数据不受影响。',
        )
        if (!sure) return
        setNotice({ ok: null, text: '正在清空日志…' })
        postJson(LOG_CLEAR_URL, { confirm: true }).then((value) => {
          if (value.ok === true) {
            setNotice({ ok: true, text: '已清空日志（删除 ' + value.removed + ' 个文件）。' })
          } else {
            setNotice({
              ok: false,
              text: '清空日志失败：' + String(value.message || value.error || '未知错误'),
            })
          }
        })
      }

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
          '这里能看、能搜、能删。判断该管哪条靠每行的来源、取回次数与取代标记；' +
            '点「删除」即物理删除，没有二次确认，也没有回收站 —— 但删过的内容会被留痕，' +
            '同样的内容不会再被写回来。',
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
          // 两个日志入口放在状态栏、与「刷新」同一排：它们是维护动作，不是浏览动作。
          React.createElement('button', { className: 'lattice-btn', onClick: exportLogs }, '导出日志'),
          React.createElement('button', { className: 'lattice-btn', onClick: clearLogs }, '清空日志'),
        ),
      )

      if (notice !== null) {
        children.push(
          React.createElement(
            'div',
            { className: 'lattice-bar', key: 'notice' },
            React.createElement(
              'span',
              { className: notice.ok === false ? 'lattice-status lattice-status-bad' : 'lattice-ok' },
              notice.text,
            ),
          ),
        )
      }

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
        for (const row of rows) rowNodes.push(renderRow(row, true, forget))
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
        for (const hit of hits) hitNodes.push(renderRow(hit, true, forget))
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
