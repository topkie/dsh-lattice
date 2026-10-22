// dsh-lattice — 浏览器半（记忆管理界面）。
//
// 这个文件是**手写的发布产物**，不是构建输出。宿主按 package.json 的 exports["./client"]
// 把它的字节原样读出来送进页面（见 dsh-client-modules 的 clientExportOf），所以这里直接写
// window.__ModuleLoader__.load({ id, factory })，不引入任何前端构建链：不需要打包器、
// 不需要 JSX、不需要 React 的 npm 包 —— React 由宿主的平台模块表提供。
//
// 它兑现的是设计说明 §43 的「界面」那一节：**能判断该管哪条**。外加两件与降级日志有关的事：
//   列表（库里有什么）、搜索（定位到某一条）、归属显示（谁写的 / 取回几次 / 是否被取代）、
//   **删除**（§44）、**导出日志 / 清空日志**（这两件事在日志模块里，与记忆数据分开）。
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
// 健康面板（下半的 HealthPanel）是唯一新增的展示块：只消费只读路由 `/api/lattice-audit`
// 的 JSON，不查表、不另算指标、不发写请求。
// 刻意**不做**的（§43 的「不做」表里剩下的）：不主动推送（无未读标记、无角标、无弹窗）、
// 不做编辑、不做多 scope 管理。所以平时没有任何定时器 —— 取数只发生在挂载、翻页、
// 改筛选、点搜索、点刷新这五种动作上（面板跟着「刷新」一起重取）。
//
// **唯一的例外**是整理入口：它在「已规划 / 正在整理」这两个过渡态里每秒取一次体检，最多 90 次。
// 那两个状态都会自己走向终点，人在等一个已知会到来的结果；不轮询的话点了确认之后界面会停在
// 「已规划」不动，直到手动刷新 —— 而那时它早跑完了（实测：库里的状态已经正确清空，界面还停着）。
//
// 数据来自宿主半的多条路由（只读与写各若干，见 src/index.ts 里的路径常量）。两侧各写
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
    /** 目录：分页 + 过滤。**不含正文** —— 所以列表里只有摘要。 */
    const ATOMS_URL = '/api/lattice-atoms'
    /**
     * 条目详情：点开某一条时才取它的全文。与宿主半 src/index.ts 的 ATOM_ROUTE_PATH 必须同值。
     *
     * 为什么不预取：正文在列表接口里是**故意**不带的（那是给模型的上下文预算）；
     * 界面若要「点开才取」，这一条路由就是唯一入口。预取等于每次翻页拉整页正文。
     */
    const ATOM_DETAIL_URL = '/api/lattice-atom'
    /** 搜索：一条查询进，若干条命中出。 */
    const SEARCH_URL = '/api/lattice-search'
    /** 删除：写端点。与宿主半 src/index.ts 的 FORGET_ROUTE_PATH 必须同值。 */
    const FORGET_URL = '/api/lattice-forget'
    /** 归档 / 恢复：写端点。与 ARCHIVE_ROUTE_PATH / UNARCHIVE_ROUTE_PATH 必须同值。 */
    const ARCHIVE_URL = '/api/lattice-archive'
    const UNARCHIVE_URL = '/api/lattice-unarchive'
    /** 归档位的值：与宿主半 db/flags.ts 的 FLAG_ARCHIVED 必须同值（浏览器半不能 import）。 */
    const FLAG_ARCHIVED = 16
    /** 待拆分位的值：与 db/flags.ts 的 FLAG_SPLIT_PENDING 必须同值。带这一位的行要给出两个决定。 */
    const FLAG_SPLIT_PENDING = 1
    /** 拆分候选的两个决定：写端点。与 SPLIT_CONFIRM_ROUTE_PATH / SPLIT_IGNORE_ROUTE_PATH 必须同值。 */
    const SPLIT_CONFIRM_URL = '/api/lattice-split-confirm'
    const SPLIT_IGNORE_URL = '/api/lattice-split-ignore'
    /** 导出降级日志：只读路由，响应是 CSV 附件。与 LOG_EXPORT_ROUTE_PATH 必须同值。 */
    const LOG_EXPORT_URL = '/api/lattice-log-export'
    /** 清空降级日志：写端点，要求 { confirm: true }。与 LOG_CLEAR_ROUTE_PATH 必须同值。 */
    const LOG_CLEAR_URL = '/api/lattice-log-clear'
    /** 体检：只读路由，健康面板的数据来源。与 AUDIT_ROUTE_PATH 必须同值。 */
    const AUDIT_URL = '/api/lattice-audit'
    /** 整理入口的两条写路由（与 src/index.ts 的常量必须同值）。 */
    const RECLUSTER_PLAN_URL = '/api/lattice-recluster-plan'
    const RECLUSTER_CANCEL_URL = '/api/lattice-recluster-cancel'
    /** 清空「学到的入口」：写端点，要求 { confirm: true }。 */
    const LEARNED_CLEAR_URL = '/api/lattice-learned-clear'

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
      // 搜索条贴在视口顶部：它原来排在列表与分页之后，条目一多就被挤出视口。
      // 用 sticky 而不是 fixed：sticky 元素在文档流里**照常占位**，所以不会盖住列表内容，
      // 也就不需要拿一个补偿性的 padding 去猜它有多高。底色是为了让下方滚过的内容不透过它。
      '.lattice-search { position: sticky; top: 0; z-index: 2; background: var(--dsw-alias-bg-layer-1); padding: 8px 0; }',
      '.lattice-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.lattice-status { font-size: 12px; color: var(--dsw-alias-label-primary); }',
      '.lattice-status-bad { color: var(--dsw-alias-state-error-primary); }',
      '.lattice-btn { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }',
      '.lattice-btn:disabled { color: var(--dsw-alias-label-secondary); cursor: default; }',
      '.lattice-select, .lattice-input { font-size: 12px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }',
      '.lattice-input { min-width: 220px; }',
      // 列表自己滚：长列表只在框内滚动，搜索条与分页因此不会被顶出屏幕。
      // 高度上限取视口比例而不是某个像素数：它要留出上方状态栏与下方分页的位置，
      // 但那个「留多少」跟窗口大小走，写死像素只会在矮窗口里失准。
      '.lattice-rows { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); max-height: 60vh; overflow-y: auto; }',
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
      // 归档按钮与删除同形但**不**用告警色：它可恢复，视觉上不该和不可撤销的动作一样重。
      '.lattice-act { font-size: 11px; padding: 1px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }',
      '.lattice-act:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-primary); }',
      '.lattice-ok { font-size: 12px; color: var(--dsw-alias-label-primary); }',
      '.lattice-results { margin-top: 14px; }',
      // 摘要可点开：人手会去点那行字，不点按钮。光标给出来，免得「点了没反应」。
      '.lattice-summary-open { cursor: pointer; }',
      '.lattice-detail-toggle { margin-top: 4px; }',
      '.lattice-detail { margin-top: 6px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }',
      '.lattice-detail-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }',
      // 被取代的条目在详情里必须一眼看出来：列表行靠压暗区分，点开的是一段纯文字，
      // 没有这句话就会被当成现行条文读。
      '.lattice-detail-superseded { color: var(--dsw-alias-state-error-primary); }',
      // 正文装在**容器内滚动**的盒子里：5000 字的条目若把页面撑开，删除按钮与搜索框会被
      // 挤出视口 —— 判据要的是「点开后页面高度不变」。
      '.lattice-detail-body { max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-primary); }',
      // 健康面板：四组数字排成可换行的一行组，标题小一号压暗。它回答「哪块退化了」，不是给全部字段上屏。
      '.lattice-health { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); padding: 8px 10px; margin: 0 0 10px; }',
      '.lattice-health-group { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-primary); margin: 0 0 4px; }',
      '.lattice-health-title { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
    ].join('\n')

    const CSS_TAG_ID = 'dsh-lattice/ui.css'
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') === null
    ) {
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
          return {
            ok: false,
            status: response.status,
            error: 'HTTP ' + response.status + '：' + text.slice(0, 300),
          }
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
    function atomsUrl(offset, origin, scope, includeArchived) {
      const parts = ['offset=' + offset]
      if (origin !== '') parts.push('origin=' + encodeURIComponent(origin))
      if (scope !== '') parts.push('scope=' + encodeURIComponent(scope))
      // 只有勾选时才传：默认请求不带这个参数 = 只看未归档。
      if (includeArchived === true) parts.push('includeArchived=1')
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
      // 归档只在「显示已归档」打开时才会出现在列表里；标记负责说明它为什么不参与召回。
      if (((row.flags || 0) & FLAG_ARCHIVED) !== 0) parts.push('已归档')
      // 待拆分：这一条是从超长原文按长度切出来的，切点没有按内容判断过。
      // 写「待拆分」而不是「应拆分」—— 该不该拆要人来判，见行尾的两个按钮。
      if (((row.flags || 0) & FLAG_SPLIT_PENDING) !== 0) parts.push('待拆分')
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
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        ' ' +
        pad(d.getHours()) +
        ':' +
        pad(d.getMinutes())
      )
    }

    /**
     * 目录/搜索共用的一行渲染。superseded 的行压暗一档。
     *
     * 第三参 `onForget` 给了才画删除按钮。为什么要能不给：搜索结果与目录是两份数据，
     * 但删除是同一件事 —— 让搜索结果也带按钮，用户就不必「先搜到、再去目录里找回来」。
     *
     * 第五参 `onSplit(row, confirmed)` 只在带待拆分位时用到：这一行是从超长原文按长度
     * 切出来的，切点没有按内容判断过，所以给两个决定 ——「确认要拆」与「忽略」。两个
     * 按钮只出现在候选行上，其余行一个字节都不多。
     */
    function renderRow(row, scopeOn, onForget, onArchive, onSplit, expand) {
      const superseded = row.supersededBy !== null && row.supersededBy !== undefined
      const head = [
        React.createElement('span', { className: 'lattice-id', key: 'id' }, '#' + row.id),
        React.createElement(
          'span',
          { className: 'lattice-mark', key: 'marks' },
          '[' + (row.kind || '-') + '·' + marks(row) + ']',
        ),
      ]
      if (scopeOn && row.scope && row.scope !== 'global') {
        head.push(
          React.createElement('span', { className: 'lattice-scope', key: 'scope' }, '{' + row.scope + '}'),
        )
      }
      if (typeof onArchive === 'function') {
        // 一个按钮按当前状态二选一：归档与恢复是同一个开关的两个方向，并排画两个只会让人猜。
        const archived = ((row.flags || 0) & FLAG_ARCHIVED) !== 0
        head.push(
          React.createElement(
            'button',
            {
              className: 'lattice-act' + (typeof onForget === 'function' ? '' : ' lattice-head-right'),
              key: 'archive',
              onClick: () => onArchive(row, archived),
            },
            archived ? '恢复' : '归档',
          ),
        )
      }
      if (((row.flags || 0) & FLAG_SPLIT_PENDING) !== 0 && typeof onSplit === 'function') {
        // 两个动作都清这一位，差别只在「记不记一条状态」—— 按钮上不必解释这个差别，
        // 提示语在点完之后给（见 decideSplit）。确认不执行拆分，所以它可逆，不弹二次确认。
        head.push(
          React.createElement(
            'button',
            {
              className: 'lattice-act',
              key: 'split',
              onClick: () => onSplit(row, true),
            },
            '确认要拆',
          ),
        )
        head.push(
          React.createElement(
            'button',
            {
              className: 'lattice-act',
              key: 'split-ignore',
              onClick: () => onSplit(row, false),
            },
            '忽略',
          ),
        )
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
      // 展开态由调用方传进来（renderRow 是普通函数，不能自己持状态 —— 它在循环里被调用）。
      // 没有 expand 的调用点（比如将来别处复用）就完全不长出这一块。
      const canExpand = expand !== null && expand !== undefined
      const open = canExpand && expand.opened !== null && expand.opened.atomId === row.id
      const body = [
        React.createElement('div', { className: 'lattice-row-head', key: 'head' }, head),
        React.createElement(
          'div',
          {
            className: canExpand ? 'lattice-summary lattice-summary-open' : 'lattice-summary',
            key: 'summary',
            // 摘要本身就是点入口：人手会去点那行字。没有 expand 时不给 onClick，
            // 免得出现一个「看着能点、点了没反应」的行。
            onClick: canExpand ? () => expand.onToggle(row) : undefined,
          },
          row.summary,
        ),
      ]
      if (canExpand) {
        body.push(
          React.createElement(
            'button',
            {
              className: 'lattice-act lattice-detail-toggle',
              key: 'detail-toggle',
              onClick: () => expand.onToggle(row),
            },
            open ? '收起' : '展开全文',
          ),
        )
        if (open) body.push(renderDetail(expand.opened.data))
      }
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

    /**
     * 展开区：一条记忆的全文。
     *
     * 三件事必须在这里同时成立，否则「点开看全文」只是把截断换了个位置：
     *   1. **正文不截断**：显示的是详情路由给的整段 text，一个字都不切；
     *   2. **字数同源**：显示的是宿主半 SQL `length(text)` 的数（atom.textLength），
     *      不是前端自己数收到的字节 —— 两处各数一遍，早晚对不上；
     *   3. **被取代要说清**：列表行用压暗区分，点开的正文若只是一段文字，
     *      人会把旧条文当现行条文读。
     *
     * data 为 null 表示正文还在路上；ok:false 表示取失败。两种都不是「空条目」。
     */
    function renderDetail(data) {
      if (data === null || data === undefined) {
        return React.createElement(
          'div',
          { className: 'lattice-detail', key: 'detail' },
          React.createElement('div', { className: 'lattice-detail-meta' }, '正在读取全文…'),
        )
      }
      if (data.ok !== true) {
        return React.createElement(
          'div',
          { className: 'lattice-detail', key: 'detail' },
          React.createElement(
            'div',
            { className: 'lattice-detail-meta lattice-detail-superseded' },
            '读取失败：' + String(data.error || data.message || '未知错误'),
          ),
        )
      }
      const atom = data.atom
      // 字数来自宿主半 SQL length(text)（atom.textLength），前端不自己数：两处各数一遍，
      // 遇到代理对就会差一截，而判据要的是「与 SELECT length(text) 差 0」。
      const meta = atom.kind + ' · ' + originLabel(atom.origin) + ' · 共 ' + atom.textLength + ' 字'
      const nodes = [React.createElement('div', { className: 'lattice-detail-meta', key: 'meta' }, meta)]
      if (atom.supersededBy !== null && atom.supersededBy !== undefined) {
        nodes.push(
          React.createElement(
            'div',
            { className: 'lattice-detail-meta lattice-detail-superseded', key: 'superseded' },
            '已被 #' + atom.supersededBy + ' 取代 —— 下面这段是旧条文，不是现行内容',
          ),
        )
      }
      nodes.push(React.createElement('div', { className: 'lattice-detail-body', key: 'body' }, atom.text))
      return React.createElement('div', { className: 'lattice-detail', key: 'detail' }, nodes)
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
      /** 「显示已归档」：默认不勾，勾上后目录请求带 includeArchived=1。 */
      const [includeArchived, setIncludeArchived] = React.useState(false)
      /** 刚才那次删除的结果（成功或失败都要说给用户听）。 */
      const [notice, setNotice] = React.useState(null)
      /**
       * 点开的那一条：{ atomId, data }。同一时刻只开一条 —— 两段长正文同时展开，
       * 页面还是要滚到看不见按钮。data 为 null 表示正文还在路上。
       */
      const [opened, setOpened] = React.useState(null)

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
        getJson(atomsUrl(offset, origin, scope, includeArchived)).then((value) => {
          if (alive) setPage(value)
        })
        return () => {
          alive = false
        }
      }, [offset, origin, scope, includeArchived, nonce])

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
                '已删除 #' +
                value.atomId +
                '「' +
                String(value.summary || '').slice(0, 40) +
                '」' +
                again +
                ' · 内容指纹 ' +
                String(value.tombstoneId) +
                ' 号墓碑已留痕，同样的内容不会再被写入',
            })
          } else {
            setNotice({ ok: false, text: '删除失败：' + String(value.error || '未知错误') })
          }
          setFound(null)
          setNonce(nonce + 1)
        })
      }

      /**
       * 归档 / 恢复一条记忆。
       *
       * 与删除同一个形状：不乐观更新、成功后重取目录并清掉过期的搜索结果。
       * 与删除的区别只有一条 —— 归档改的是可见性，不是内容，所以随时可以点「恢复」。
       */
      function archive(row, archived) {
        setNotice({ ok: null, text: (archived ? '正在恢复 #' : '正在归档 #') + row.id + '…' })
        postJson(archived ? UNARCHIVE_URL : ARCHIVE_URL, { atom_id: row.id }).then((value) => {
          if (value.ok === true) {
            // changed=false 是幂等命中，不是失败：说「之前就是这个状态」，别让用户以为按钮没生效。
            const again = value.changed === false ? '（之前就是这个状态）' : ''
            setNotice({
              ok: true,
              text: (value.archived === true ? '已归档 #' : '已恢复 #') + value.atomId + again,
            })
          } else {
            setNotice({
              ok: false,
              text: (archived ? '恢复失败：' : '归档失败：') + String(value.error || '未知错误'),
            })
          }
          setFound(null)
          setNonce(nonce + 1)
        })
      }

      /**
       * 对一条待拆分候选做决定：确认要拆 / 忽略。
       *
       * 两个动作都清掉待拆分位，差别只在宿主半记不记状态：确认之后，这条下次被召回时
       * 锚行会提示「用户已确认应拆分，可按内容重写并声明 supersedes」；忽略只留一条日志。
       * **都不执行拆分** —— 正文、条数、入口与边都不动，所以两个动作都可逆，不弹二次确认。
       */
      function decideSplit(row, confirmed) {
        setNotice({ ok: null, text: (confirmed ? '正在确认 #' : '正在忽略 #') + row.id + '…' })
        postJson(confirmed ? SPLIT_CONFIRM_URL : SPLIT_IGNORE_URL, { atom_id: row.id }).then((value) => {
          if (value.ok === true) {
            // changed=false 是幂等命中，不是失败：按钮可能被点了两次。
            const again = value.changed === false ? '（之前就处理过了）' : ''
            setNotice({
              ok: true,
              text: confirmed
                ? '已确认 #' +
                  value.atomId +
                  ' 应拆分' +
                  again +
                  '：下次召回会提示按内容重写并声明 supersedes（本次不改正文）'
                : '已忽略 #' + value.atomId + ' 的拆分提示' + again,
            })
          } else {
            setNotice({
              ok: false,
              text: (confirmed ? '确认失败：' : '忽略失败：') + String(value.error || '未知错误'),
            })
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

      /**
       * 点开 / 收起一条的全文。
       *
       * 为什么点开才取：目录接口按设计不带正文，界面也不预取 —— 一页 20 条全取正文，
       * 打开一个几百条的库就是几百 KB 的量，而人通常只看两条。
       *
       * 回包时核对 atomId 再落状态：用户可能在请求途中点了另一条，迟到的响应不能贴到
       * 别条上（否则界面会拿 A 的字数配 B 的正文）。
       */
      function toggleDetail(row) {
        if (opened !== null && opened.atomId === row.id) {
          setOpened(null)
          return
        }
        setOpened({ atomId: row.id, data: null })
        getJson(ATOM_DETAIL_URL + '?id=' + row.id).then((value) => {
          setOpened((current) =>
            current !== null && current.atomId === row.id ? { atomId: row.id, data: value } : current,
          )
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
          '这里能看、能搜、能归档、能删。判断该管哪条靠每行的来源、取回次数与取代标记；' +
            '「归档」之后默认不再出现在召回与列表里（勾上「显示已归档」才看得到，随时可恢复）；' +
            '带「待拆分」的行是从超长原文按长度切出来的（切点没有按内容判断过），' +
            '可以点「确认要拆」或「忽略」—— 两个动作都不改正文，只记下你的判断；' +
            '点「删除」即物理删除，没有二次确认，也没有回收站 —— 但删过的内容会被留痕，' +
            '同样的内容不会再被写回来。',
        ),
      ]

      let statusText = '读取中…'
      if (page !== null) {
        if (listed) {
          statusText =
            '共 ' + total + ' 条' + (ping !== null && ping.ok === true ? ' · v' + ping.version : '')
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
          React.createElement(
            'button',
            { className: 'lattice-btn', onClick: () => setNonce(nonce + 1) },
            '刷新',
          ),
          // 两个日志入口放在状态栏、与「刷新」同一排：它们是维护动作，不是浏览动作。
          React.createElement('button', { className: 'lattice-btn', onClick: exportLogs }, '导出日志'),
          React.createElement('button', { className: 'lattice-btn', onClick: clearLogs }, '清空日志'),
        ),
      )
      // 健康面板放在状态栏与筛选之间：它回答「库现在健康吗」，属于概览，不是筛选。
      children.push(React.createElement(HealthPanel, { key: 'health', nonce: nonce }))
      // 维护动作紧跟在健康读数之后：先看「库现在什么样」，再决定要不要动它。
      children.push(React.createElement(MaintenancePanel, { key: 'maintenance', nonce: nonce }))

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
          // 「显示已归档」：默认不勾 —— 归档的语义就是默认看不见。
          React.createElement(
            'label',
            { className: 'lattice-label', key: 'archived' },
            React.createElement('input', {
              type: 'checkbox',
              checked: includeArchived,
              onChange: (event) => {
                setIncludeArchived(event.target.checked)
                setOffset(0)
              },
            }),
            ' 显示已归档',
          ),
        ),
      )

      // 目录行与搜索结果共用同一份展开态：同一时刻只开一条，两个列表不会各开各的。
      // 声明必须排在下面两个块**之前**：搜索结果的行也用它，而 const 有暂时性死区。
      const expand = { opened: opened, onToggle: toggleDetail }

      // 搜索条与搜索结果：原来排在列表与分页**之后**，条目一多就被挤到视口外；
      // 现在放在列表之前的固定区。搜索结果也跟着挪上来 —— 否则按回车之后「命中几条」
      // 仍然在列表底部，用户看不到自己刚才那一下的动作有了结果。
      children.push(
        React.createElement(
          'div',
          { className: 'lattice-bar lattice-search', key: 'search' },
          React.createElement('input', {
            className: 'lattice-input',
            placeholder: '搜索记忆（回车）',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') runSearch()
            },
          }),
          React.createElement(
            'button',
            { className: 'lattice-btn', disabled: busy, onClick: runSearch },
            busy ? '搜索中…' : '搜索',
          ),
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
              ? '命中 ' +
                  hits.length +
                  ' 条' +
                  (found.meta && found.meta.vectorMissing === true
                    ? '（编码器不可用，本次为纯词面搜索）'
                    : '')
              : '搜索失败：' + String(found.error || '未知错误'),
          ),
        ]
        for (const hit of hits) hitNodes.push(renderRow(hit, true, forget, archive, decideSplit, expand))
        children.push(React.createElement('div', { className: 'lattice-results', key: 'results' }, hitNodes))
      }
      const rowNodes = []
      if (listed) {
        if (rows.length === 0) {
          rowNodes.push(
            React.createElement('p', { className: 'lattice-hint', key: 'empty' }, '没有符合条件的记忆。'),
          )
        }
        for (const row of rows) rowNodes.push(renderRow(row, true, forget, archive, decideSplit, expand))
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

      return React.createElement('div', { className: 'lattice-panel' }, children)
    }

    // ── 健康面板 ───────────────────────────────────────────────────────────
    //
    // 数据只有一个来源：只读路由 /api/lattice-audit 的 JSON（口径全在宿主半的
    // pipeline/audit.ts）。**面板不查 edge 表、不另算比例** —— 另算一遍就会形成第二套
    // 口径，将来两处报不同的数。整块只发只读请求：没有 postJson，也没有第二条 URL。
    //
    // 上屏的是「这个库现在健康吗、哪块退化了」：四组计数 + 图路 / 重聚类状态 + 一句
    // detail。全字段不上屏 —— 响应里还有 rows / byKind / definition，那是维护工具要的，
    // 不是打开设置页的人要的；比例与阈值也不在这边解释，detail 里已经写了口径。
    //
    // 下面的起止标记给用例用：用例把整块抽出来，断言里面没有写请求、面板自己不含数字，
    // 并把这块的纯函数抽出来喂同一次响应，逐格对照（见 test/audit-panel.test.mjs）。

    // ── 健康面板起点 ──
    /**
     * 上屏字段清单：四组计数。path 是响应里的字段路径，label 是给人看的名字。
     *
     * 只列**整数计数**：比例（singleMemberRatio 之类）与任何换算值都不上屏 —— 「0.67」
     * 不等于响应里的 0.6666666666666666，一旦在面板里换算，「面板数与接口一致」就只剩
     * 一个近似相等，而近似相等没法用一条断言钉住。比例要看，看 detail 那句与维护脚本。
     */
    const HEALTH_GROUPS = [
      {
        title: '记忆',
        fields: [
          { path: 'topics.atoms', label: '条数' },
          { path: 'topics.archived', label: '已归档' },
          { path: 'topics.withAtoms', label: '有成员的主题' },
          { path: 'topics.singleMember', label: '单成员主题' },
        ],
      },
      {
        title: '图路',
        fields: [
          { path: 'graph.inferredEdges', label: '推断边' },
          { path: 'graph.declaredEdges', label: '声明边' },
        ],
      },
      {
        title: '入口',
        fields: [
          { path: 'entries.total', label: '总数' },
          { path: 'entries.learned', label: 'learned' },
        ],
      },
      {
        title: '待处理',
        fields: [
          { path: 'duplicates.total', label: '高相似未合并对' },
          { path: 'orphans.total', label: '孤立' },
          { path: 'recall.neverRecalled', label: '从未被召回' },
        ],
      },
    ]

    /** 按 'a.b.c' 从响应里取值。取不到（字段写错 / 后端没给）得到 undefined，显示成「—」。 */
    function healthValue(report, path) {
      let node = report
      for (const key of path.split('.')) {
        if (node === null || node === undefined) return undefined
        node = node[key]
      }
      return node
    }

    /** 一个值怎么显示：null 是「没有这个数」，与 0 不是一回事（空库时比例就是 null）。 */
    function healthText(value) {
      if (value === null || value === undefined) return '—'
      return String(value)
    }

    /** 图路状态词。表外的状态原样显示，不猜。 */
    function graphStatusText(status) {
      if (status === 'built') return '已建'
      if (status === 'not-built') return '未建（召回第一次调用才会尝试建一次；体检本身不建）'
      if (status === 'too-large') return '未建（atom 数超过全量推断上限）'
      return String(status)
    }

    /**
     * 重聚类状态：null 是「从未跑过」，与「跑了、没有发现」不是一回事。
     *
     * 显示「跑过」而不是把 rebuiltAt 格式化成日期：格式化出来的数字不再等于响应里的
     * 同名值，与「面板数与接口一致」冲突。要看具体时间，读接口本身。
     */
    function rebuildText(rebuiltAt) {
      if (rebuiltAt === null || rebuiltAt === undefined || rebuiltAt <= 0) return '从未重聚类'
      return '已重聚类过'
    }

    /**
     * 把一次体检响应变成面板要显示的结构。**只搬运，不计算**：每一格的值都经
     * healthValue 从响应里取出，这一层没有任何指标运算。
     *
     * 三种形态分开：取数失败 / 空库 / 有数据。空库不给一排 0 —— 那会被读成
     * 「都查过了，没有问题」，而实际是「没有可查的东西」。
     */
    function healthModel(report) {
      if (report === null || report === undefined || report.ok !== true) {
        return {
          ok: false,
          empty: false,
          message: '体检读取失败：' + String((report && report.error) || '未知错误'),
          groups: [],
          graph: '',
          rebuild: '',
          detail: '',
        }
      }
      if (report.dataState === 'empty') {
        return {
          ok: true,
          empty: true,
          message: '库里还没有记忆 —— 还没有可体检的数据（不是「检查过、没有问题」）。',
          groups: [],
          graph: '',
          rebuild: '',
          detail: String(report.detail || ''),
        }
      }
      const groups = []
      for (const group of HEALTH_GROUPS) {
        const rows = []
        for (const field of group.fields) {
          const value = healthValue(report, field.path)
          rows.push({ path: field.path, label: field.label, value: value, text: healthText(value) })
        }
        groups.push({ title: group.title, rows: rows })
      }
      return {
        ok: true,
        empty: false,
        message: '',
        groups: groups,
        graph: graphStatusText(report.graph && report.graph.status),
        rebuild: rebuildText(report.duplicates && report.duplicates.rebuiltAt),
        detail: String(report.detail || ''),
      }
    }

    /**
     * 健康面板。挂载与点「刷新」（nonce 变）时各取一次，不轮询 —— 与目录同一条纪律。
     *
     * 只用 getJson：这一块没有任何写动作，所以源码里不该出现写请求的名字。面板自己
     * 也不含数字常量 —— 屏幕上的每个数字都来自 model（进而来自响应），这一点由用例钉住。
     */
    function HealthPanel(props) {
      const nonce = props.nonce
      const [report, setReport] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        getJson(AUDIT_URL).then((value) => {
          if (alive) setReport(value)
        })
        return () => {
          alive = false
        }
      }, [nonce])

      if (report === null) return React.createElement('p', { className: 'lattice-hint' }, '体检数据读取中…')
      const model = healthModel(report)
      if (model.ok !== true) {
        return React.createElement('p', { className: 'lattice-hint lattice-status-bad' }, model.message)
      }
      if (model.empty === true) {
        return React.createElement('p', { className: 'lattice-hint' }, model.message)
      }

      const groupNodes = []
      for (const group of model.groups) {
        const cells = [
          React.createElement('span', { className: 'lattice-health-title', key: 'title' }, group.title),
        ]
        for (const row of group.rows) {
          cells.push(
            React.createElement(
              'span',
              { className: 'lattice-health-cell', key: row.path, title: row.path },
              row.label + ' ' + row.text,
            ),
          )
        }
        groupNodes.push(
          React.createElement('div', { className: 'lattice-health-group', key: group.title }, cells),
        )
      }

      return React.createElement(
        'div',
        { className: 'lattice-health' },
        groupNodes,
        React.createElement(
          'p',
          { className: 'lattice-hint' },
          '图路：' + model.graph + ' · 重聚类：' + model.rebuild,
        ),
        React.createElement('p', { className: 'lattice-hint' }, '体检：' + model.detail),
      )
    }
    // ── 健康面板终点 ──
    // ── 维护：整理入口与清空学到的入口───────────────────────
    //
    // 两块都要**两步确认**：第一下把按钮换成「确认…」与「取消」，第二下才发请求。
    // 不用 window.confirm —— 宿主是 webview，原生对话框的形态与主题都不可控。
    //
    // 状态与条数都取自体检响应（`recluster` / `entries.learned`）：整理的四态并入体检，
    // 清空的条数本来就在面板上 —— 为这两件事各开一条只读路由只会多两次请求。
    //
    // 整理是低频人工动作，**不轮询**：只有挂载、点刷新（nonce 变）、操作成功之后各取一次。

    /**
     * 整理进行中的轮询间隔与次数上限（**只在这两个过渡态里用**）。
     *
     * 90 次 × 1 秒 ≈ 一分半：一次整理在千条量级的库上约 1 秒，这个上限只用来兜住
     * 「状态因为某种未知原因卡住」，不是为了等它跑完。
     */
    const RECLUSTER_POLL_MS = 1000
    const RECLUSTER_POLL_LIMIT = 90

    /**
     * 两块维护动作的说明（给不知道这两个词是什么意思的人）。
     *
     * 说清三件事：它在动什么、什么时候该点、做完会怎样。技术名词只留「主题」一个，
     * 因为面板上的数字就是按主题分的；「重聚类」这个词不进界面 —— 它只在代码与文档里。
     */
    const RECLUSTER_HELP =
      '把全库记忆重新归拢到主题里。主题越用越散（单成员主题占大头）时点一次；' +
      '它只改归属，不改内容、不删数据。'
    const LEARNED_HELP =
      '召回时自动记下的检索词。清掉之后，用过的说法不再更容易命中；' + '再走几次召回会重新长出来。'

    /** 四态文案。表外的值原样显示，不猜。 */
    const RECLUSTER_PHASE_TEXT = {
      idle: '未规划',
      planned: '已规划（几秒后开始）',
      running: '正在整理',
      failed: '失败可重试',
    }

    function reclusterPhaseText(phase) {
      return RECLUSTER_PHASE_TEXT[phase] || String(phase)
    }

    function MaintenancePanel(props) {
      const nonce = props.nonce
      const [report, setReport] = React.useState(null)
      const [bump, setBump] = React.useState(0)
      const [pending, setPending] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      React.useEffect(() => {
        let alive = true
        getJson(AUDIT_URL).then((value) => {
          if (alive) setReport(value)
        })
        return () => {
          alive = false
        }
      }, [nonce, bump])

      // 只在「有事情正在进行」时轮询：那两个状态会自己走向终点，人在等一个已知会到来的结果。
      // 另外两个状态不轮询 —— 所以「界面不主动刷新」这条纪律仍然成立。次数有上限，
      // 状态若因为某个未知原因卡住，界面不能一直转下去。
      const phase = report === null ? '' : (report.recluster && report.recluster.phase) || 'idle'
      React.useEffect(() => {
        if (phase !== 'planned' && phase !== 'running') return undefined
        let ticks = 0
        const timer = setInterval(() => {
          ticks += 1
          if (ticks > RECLUSTER_POLL_LIMIT) {
            clearInterval(timer)
            return
          }
          setBump((value) => value + 1)
        }, RECLUSTER_POLL_MS)
        return () => clearInterval(timer)
      }, [phase])

      if (report === null) return React.createElement('p', { className: 'lattice-hint' }, '整理状态读取中…')
      const learned = healthValue(report, 'entries.learned')
      const learnedText = healthText(learned)

      function send(url, done) {
        setBusy(true)
        setNote('')
        postJson(url, { confirm: true }).then((value) => {
          setBusy(false)
          setPending('')
          if (value && value.ok === true) {
            setNote(done(value))
            setBump(bump + 1)
          } else {
            setNote('失败：' + String((value && (value.message || value.error)) || '未知错误'))
          }
        })
      }

      const nodes = [
        React.createElement('p', { className: 'lattice-health-title', key: 'title' }, '维护'),
        // 两块都各有一行说明：只写「整理」「清空学到的入口」这两个词，人不知道它在动什么、
        // 也不知道什么时候该点。说明写在按钮**上面**，先讲清再给动作。
        React.createElement(
          'p',
          { className: 'lattice-health-title', key: 'recluster-title' },
          '整理 · ' + reclusterPhaseText(phase),
        ),
        React.createElement('p', { className: 'lattice-hint', key: 'recluster-help' }, RECLUSTER_HELP),
      ]

      // 整理：四态各自一个动作。执行中没有可点的东西 —— 取消在执行中一律被拒。
      if (phase === 'running') {
        nodes.push(
          React.createElement(
            'button',
            { className: 'lattice-btn', disabled: true, key: 'recluster' },
            '正在整理…',
          ),
        )
      } else if (phase === 'planned') {
        nodes.push(
          React.createElement(
            'button',
            {
              className: 'lattice-btn',
              disabled: busy,
              key: 'recluster',
              onClick: () => send(RECLUSTER_CANCEL_URL, () => '已取消，不会开始'),
            },
            '取消整理',
          ),
        )
      } else if (pending === 'plan') {
        nodes.push(
          React.createElement(
            'button',
            {
              className: 'lattice-act',
              disabled: busy,
              key: 'recluster',
              onClick: () => send(RECLUSTER_PLAN_URL, () => '已规划，几秒后开始'),
            },
            phase === 'failed' ? '确认重试' : '确认整理',
          ),
          React.createElement(
            'button',
            { className: 'lattice-btn', key: 'plan-cancel', onClick: () => setPending('') },
            '取消',
          ),
        )
      } else {
        nodes.push(
          React.createElement(
            'button',
            {
              className: 'lattice-act',
              disabled: busy,
              key: 'recluster',
              onClick: () => setPending('plan'),
            },
            phase === 'failed' ? '重试整理' : '开始整理',
          ),
        )
      }

      // 清空学到的入口：按钮上写条数（数字自己劝退），两步确认。0 条时不给点。
      nodes.push(
        React.createElement(
          'p',
          { className: 'lattice-health-title', key: 'clear-title' },
          '学到的入口 · ' + learnedText + ' 条',
        ),
        React.createElement('p', { className: 'lattice-hint', key: 'clear-help' }, LEARNED_HELP),
      )
      if (pending === 'clear') {
        nodes.push(
          React.createElement(
            'button',
            {
              className: 'lattice-act',
              disabled: busy,
              key: 'clear',
              onClick: () => send(LEARNED_CLEAR_URL, (value) => '已清空 ' + String(value.cleared) + ' 条'),
            },
            '确认清空 ' + learnedText + ' 条',
          ),
          React.createElement(
            'button',
            { className: 'lattice-btn', key: 'clear-cancel', onClick: () => setPending('') },
            '取消',
          ),
        )
      } else {
        nodes.push(
          React.createElement(
            'button',
            {
              className: 'lattice-act',
              disabled: busy || learned === 0 || learned === null || learned === undefined,
              key: 'clear',
              onClick: () => setPending('clear'),
            },
            '清空学到的入口（' + learnedText + ' 条）',
          ),
        )
      }

      if (note !== '') nodes.push(React.createElement('p', { className: 'lattice-hint', key: 'note' }, note))
      return React.createElement('div', { className: 'lattice-health' }, nodes)
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
