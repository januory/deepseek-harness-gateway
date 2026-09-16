// dsh-gateway-agent — client half（浏览器面）。
//
// 以 classic factory 经 window.__ModuleLoader__ 自注册（无 ESM import/export），
// react 是平台 seed word。提供"网关接入"设置卡：网关地址、入网申请、连接状态。
// Remote 契约与 src/index.js 逐字镜像（must match）。
//
// 重要：本文件作为 classic script 会被拼进同一个 bundle（与 remote-workspaces 等
// 其它 client 插件并列），顶层 var PACKAGE/NAMESPACE/INVOCATIONS 会互相覆盖——
// 后加载的插件会改掉这里的值。必须用 IIFE 把顶层声明隔离在私有作用域内。

;(function () {
var PACKAGE = '@januory/dsh-gateway-agent'
var NAMESPACE = 'gatewayAgent'

// 身份 JSON 边界 codec：新版 DSH 的 typert 用 create() 工厂校验 strict codec
// （旧版读 schema）；两字段同源并存，同一份产物在新旧宿主上都能挂载。
var JSON_SCHEMA = Object.freeze({ parse: function (value) { return value } })
var JSON_CODEC = Object.freeze({
  mode: 'strict',
  typeSymbol: 'JsonValue',
  create: function () { return JSON_SCHEMA },
  schema: JSON_SCHEMA,
})

function jsonParameter(paramName) {
  return { name: paramName, wire: paramName, source: 'json', codec: JSON_CODEC }
}

function invocation(method, parameters) {
  return {
    id: NAMESPACE + '/' + method,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method: method,
    invocation: { kind: 'direct' },
    parameters: parameters || [],
    result: JSON_CODEC,
  }
}

// 与 src/index.js 逐字镜像，改动必须两端同步（must match）。
var INVOCATIONS = [
  invocation('status'),
  invocation('getConfig'),
  invocation('applyConfig', [jsonParameter('config')]),
  invocation('onboard', [jsonParameter('gatewayUrl'), jsonParameter('pairingCode')]),
  invocation('getDaemonConfig'),
  invocation('saveDaemonConfig', [jsonParameter('config')]),
]

// Remote 调用 resolve 为 { value: <host 返回 { ok, ... }> }；unwrap 取出内层信封。
function unwrap(res) {
  var v = res && res.value
  if (v === undefined || v === null) return { error: '无响应' }
  if (v.ok === false) {
    return { error: v.error && v.error.message ? v.error.message : '远程调用失败' }
  }
  return v
}

function stateMeta(state) {
  switch (state) {
    case 'unconfigured': return { label: '未配置', color: '#8b8f98' }
    case 'connecting': return { label: '连接中', color: '#f5a623' }
    case 'pending': return { label: '待批准', color: '#f5a623' }
    case 'online': return { label: '在线', color: '#46a758' }
    case 'error': return { label: '错误', color: '#e5484d' }
    default: return { label: state || '未知', color: '#8b8f98' }
  }
}

// 守护进程（dsh 生命周期）状态：由独立 supervisor 进程上报。
function daemonMeta(state) {
  switch (state) {
    case 'running': return { label: '运行中', color: '#46a758' }
    case 'starting': return { label: '处理中', color: '#f5a623' }
    case 'stopped': return { label: '已关闭', color: '#8b8f98' }
    case 'exited': return { label: '已退出', color: '#e5484d' }
    case 'unknown': return { label: '未知', color: '#8b8f98' }
    default: return { label: '未接入守护进程', color: '#8b8f98' }
  }
}

function timeText(iso) {
  if (!iso) return '—'
  var d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  return d.toLocaleString()
}

window.__ModuleLoader__.load({
  id: PACKAGE,
  factory: function (require) {
    var React = require('react')
    var createElement = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    // 窄屏/手机视口检测：在插件内做移动端排版适配，无需网关侧适配器。
    // 设定在 600px 断点（设置面板在移动端被压缩到 ~360px，内容区更窄），
    // 返回是否处于窄屏，并跟随视口变化更新。无 matchMedia 时回退为 false。
    function useIsNarrow() {
      var _n = useState(false)
      var narrow = _n[0]
      var setNarrow = _n[1]
      useEffect(function () {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        var mql = window.matchMedia('(max-width: 600px)')
        var update = function () { setNarrow(mql.matches) }
        update()
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', update)
          return function () { mql.removeEventListener('change', update) }
        }
        if (typeof mql.addListener === 'function') {
          mql.addListener(update)
          return function () { mql.removeListener(update) }
        }
        return undefined
      }, [])
      return narrow
    }

    var S = {
      wrap: { padding: 16, fontSize: 14, lineHeight: 1.6, maxWidth: 720, color: 'inherit' },
      title: { fontWeight: 600, fontSize: 16, margin: '0 0 4px', color: 'inherit' },
      desc: { margin: '0 0 14px', color: '#8b8f98', fontSize: 13, lineHeight: 1.6 },
      field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 },
      fieldLabel: { color: '#8b8f98', fontSize: 12.5 },
      input: {
        padding: '7px 10px', fontSize: 13.5, width: '100%', boxSizing: 'border-box',
        background: 'rgba(127,127,127,0.08)', color: 'inherit',
        border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6,
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 },
      btn: {
        padding: '7px 14px', fontSize: 13.5, cursor: 'pointer',
        background: 'rgba(127,127,127,0.12)', color: 'inherit',
        border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6,
      },
      primary: {
        padding: '7px 14px', fontSize: 13.5, cursor: 'pointer',
        background: '#6e56cf', color: '#fff', border: '1px solid transparent',
        borderRadius: 6, fontWeight: 600,
      },
      disabled: { opacity: 0.5, cursor: 'not-allowed' },
      error: {
        background: 'rgba(229,72,77,0.12)', color: '#e5484d',
        border: '1px solid rgba(229,72,77,0.35)', borderRadius: 6,
        padding: '9px 12px', fontSize: 13, marginTop: 12,
      },
      notice: {
        background: 'rgba(70,167,88,0.12)', color: '#46a758',
        border: '1px solid rgba(70,167,88,0.35)', borderRadius: 6,
        padding: '9px 12px', fontSize: 13, marginTop: 12,
      },
      statusCard: {
        marginTop: 16, border: '1px solid rgba(127,127,127,0.3)', borderRadius: 8,
        padding: 12, background: 'rgba(127,127,127,0.06)',
      },
      statusHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
      dot: { width: 9, height: 9, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5,
        overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0,
      },
      kv: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '4px 12px', fontSize: 12.5 },
      kvKey: { color: '#8b8f98' },
      // 守护进程服务区（卡片 + 脚本编辑）
      daemonCard: {
        marginTop: 18, paddingTop: 16, borderTop: '1px solid rgba(127,127,127,0.3)',
      },
      hint: { color: '#8b8f98', fontSize: 12, lineHeight: 1.5 },
      checkRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 4, fontSize: 13 },
      checkbox: { width: 16, height: 16, flexShrink: 0 },
      // 设置分区页签：网关接入 / 守护进程服务。两块内容都保持挂载，只用
      // display 切换——切走再切回来不会丢掉正在编辑的脚本。
      tabs: { display: 'flex', gap: 4, margin: '0 0 2px', borderBottom: '1px solid rgba(127,127,127,0.25)' },
      tab: {
        appearance: 'none', background: 'transparent', border: 'none', font: 'inherit',
        borderBottom: '2px solid transparent', color: '#8b8f98', marginBottom: -1,
        padding: '8px 12px', fontSize: 13.5, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      },
      tabActive: { color: 'inherit', borderBottomColor: '#6e56cf', fontWeight: 600 },
      tabDot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
      pane: { paddingTop: 14 },
      hidden: { display: 'none' },
    }

    function kv(key, value) {
      return createElement(
        'div',
        { style: { display: 'contents' } },
        createElement('span', { style: S.kvKey }, key),
        createElement('span', { style: S.mono }, String(value)),
      )
    }

    // 统一远程调用入口：方法缺失时给出「命名空间上有哪些属性」的明确报错。
    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise(function (_resolve, reject) {
          setTimeout(function () { reject(new Error('调用超时（' + ms / 1000 + 's）')) }, ms)
        }),
      ])
    }

    function remoteCall(namespace, method, args) {
      if (!namespace) throw new Error('客户端尚未就绪')
      var fn = namespace[method]
      if (typeof fn !== 'function') {
        var keys = []
        try { keys = Object.keys(namespace) } catch (e) { keys = [] }
        throw new Error('远程方法 ' + method + ' 不可用（命名空间属性: ' + (keys.length ? keys.join(', ') : '(空)') + '）')
      }
      return fn.apply(null, args || [])
    }

    function DaemonField(props) {
      return createElement(
        'label',
        { style: S.field },
        createElement('span', { style: S.fieldLabel }, props.label),
        props.hint ? createElement('span', { style: S.hint }, props.hint) : null,
        createElement('textarea', {
          value: props.value || '',
          placeholder: props.placeholder || '',
          spellCheck: false,
          rows: props.rows || 2,
          onChange: function (e) { props.onChange(e.target.value) },
          style: Object.assign({}, S.mono, {
            padding: '7px 10px', background: 'rgba(127,127,127,0.08)', color: 'inherit',
            border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6,
            resize: 'vertical', minHeight: 44, lineHeight: 1.5,
          }, props.narrow ? { fontSize: 16 } : {}),
        }),
      )
    }

    // 守护进程服务：勾选后由独立 supervisor 进程托管本机 dsh 的启动/停止/重启，
    // 网关「机器目录」据此给出三个按钮。脚本即网关将要执行的命令，可改。
    function DaemonSection(props) {
      var remote = props.remote
      var status = props.status
      // 作为页签内容渲染时不再需要分区标题和上边框（页签本身就是标题）。
      var tabbed = props.tabbed === true
      var daemon = status && status.daemon ? status.daemon : null

      var _cfg = useState(null)
      var cfg = _cfg[0]
      var setCfg = _cfg[1]
      var _err = useState(null)
      var error = _err[0]
      var setError = _err[1]
      var _notice = useState(null)
      var notice = _notice[0]
      var setNotice = _notice[1]
      var _busy = useState(false)
      var busy = _busy[0]
      var setBusy = _busy[1]
      var narrow = useIsNarrow()

      // 首次拿到 daemon 配置就填进本地表单；之后不再覆盖用户正在编辑的内容。
      useEffect(function () {
        if (cfg || !daemon || !daemon.config) return
        setCfg(daemon.config)
      }, [daemon, cfg])

      if (!daemon) return null

      var scripts = cfg && cfg.scripts ? cfg.scripts : (daemon.config ? daemon.config.scripts : {}) || {}
      var child = cfg && cfg.child ? cfg.child : (daemon.config ? daemon.config.child : {}) || {}
      var enabled = cfg ? cfg.enabled === true : daemon.enabled === true
      var isWin = /^win/i.test(String((typeof navigator !== 'undefined' && navigator.platform) || ''))
      var meta = daemonMeta(daemon.state ? daemon.state.state : '')
      // `supervisorPid` stays in daemon-state.json forever, so liveness decides:
      // the host reports whether that pid still exists (`supervisorAlive`).
      var supervised = !!(daemon.state && daemon.state.supervisorPid) && daemon.supervisorAlive !== false
      // With no supervisor socket the state is unverifiable: showing the last reported
      // 「运行中」 next to 「守护进程未运行」 reads like a contradiction, so the head falls
      // back to 离线 — the same word the portal's machine catalog uses for this case.
      var headMeta = supervised ? meta : { label: '离线', color: '#8b8f98' }

      function patch(fields) {
        setCfg(Object.assign({}, cfg || daemon.config || {}, fields))
      }
      function patchScripts(fields) {
        patch({ scripts: Object.assign({}, scripts, fields) })
      }
      function patchChild(fields) {
        patch({ child: Object.assign({}, child, fields) })
      }

      // 保存会按勾选状态启停守护进程（后端做），结果如实回显——包括「服务管理器又把它拉起来了」
      // 和「拒绝杀掉不是本插件的进程」这两种情况。
      function saveNotice(wantEnabled, sup) {
        var action = sup && sup.action
        if (!action) return wantEnabled ? '已保存。守护进程会按新脚本执行启动/停止/重启。' : '已保存：守护进程服务已关闭。'
        if (action === 'started') return '已保存：守护进程已启动' + (sup.detail ? '（' + sup.detail + '）' : '') + '。'
        if (action === 'already-running') return '已保存：守护进程此前已在运行。'
        if (action === 'stopped') return '已保存：守护进程已停止。' + (sup.restartedByService ? ' 注意：它随即又被服务管理器拉起——要真正关掉请用 systemctl / Stop-ScheduledTask 停掉那个服务。' : '')
        if (action === 'not-running') return '已保存：守护进程本来就没有运行。'
        if (action === 'refused') return '已保存，但没有停止守护进程：' + (sup.detail || '当前记录的进程不是本插件的守护进程') + '。'
        return '已保存，但启停守护进程失败：' + (sup.detail || action) + '。装成系统服务（README「启动 / 关闭守护进程」）更可靠。'
      }

      function save() {
        if (!remote) { setError('客户端尚未就绪'); return }
        setBusy(true)
        setError(null)
        setNotice(null)
        var body = Object.assign({}, cfg || {}, {
          enabled: enabled,
          scripts: scripts,
          child: child,
        })
        try {
          withTimeout(Promise.resolve(remoteCall(remote, 'saveDaemonConfig', [body])), 20000).then(
            function (r) {
              setBusy(false)
              var v = unwrap(r)
              if (v.error) { setError(v.error); return }
              if (v.config) setCfg(v.config)
              setNotice(saveNotice(enabled, v.supervisorControl))
            },
            function (e) { setBusy(false); setError(String(e && e.message ? e.message : e)) },
          )
        } catch (e) {
          setBusy(false)
          setError(String(e && e.message ? e.message : e))
        }
      }

      var startPh = isWin ? 'powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\\service\\dsh-lifecycle.ps1" start {port}' : 'nohup dsh web --port {port} >/dev/null 2>&1 &'
      var stopPh = isWin ? 'powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\\service\\dsh-lifecycle.ps1" stop {port}' : 'pkill -f "dsh web"'
      var statusPh = isWin ? 'powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\\service\\dsh-lifecycle.ps1" status {port}' : 'pgrep -f "dsh web" >/dev/null'

      return createElement(
        'div',
        { style: tabbed ? null : S.daemonCard },
        tabbed ? null : createElement('div', { style: S.title }, '守护进程服务'),
        createElement(
          'p',
          { style: S.desc },
          '勾选后，本机由一个独立的守护进程（supervisor）托管 dsh 的启动/停止/重启，并由网关「机器目录」远程操作。守护进程不是 dsh 的子进程：dsh 被关闭后它仍然在线，因此可以被重新启动。',
        ),
        createElement(
          'p',
          { style: S.hint },
          '点「保存守护设置」会按勾选状态启动 / 停止这个守护进程（勾上就启动，取消就停掉）。要开机、重启后自动常驻，请照 README「启动 / 关闭守护进程」把它装成系统服务。',
        ),
        createElement(
          'label',
          { style: S.checkRow },
          createElement('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: function (e) { patch({ enabled: e.target.checked }) },
            style: S.checkbox,
          }),
          createElement('span', { style: { fontWeight: 600 } }, '启用守护进程服务（允许网关远程启停本机 dsh）'),
        ),
        createElement(
          'div',
          { style: S.statusCard },
          createElement(
            'div',
            { style: S.statusHead },
            createElement('span', { style: Object.assign({}, S.dot, { background: headMeta.color }) }),
            createElement('strong', { style: { color: headMeta.color, fontSize: 13.5 } }, headMeta.label),
            createElement(
              'span',
              { style: S.hint },
              supervised
                ? '守护进程在线（pid ' + daemon.state.supervisorPid + '）'
                : daemon.state && daemon.state.supervisorPid
                  ? '守护进程未运行'
                  : '守护进程未运行 / 未接入',
            ),
          ),
          createElement(
            'div',
            { style: S.kv },
            // 整行文案与卡片其余部分统一用中文（运行中 / 已关闭 / 已退出 / 处理中…）：
            // 守护进程不在时，daemon-state.json 里那个 running 只是历史值，此时就是「已停止」。
            kv('守护状态', supervised
              ? (daemon.state && daemon.state.state ? daemonMeta(daemon.state.state, daemon.state.lastAction).label : '—')
              : '已停止'),
            kv('最近动作', daemon.state && daemon.state.lastAction ? daemon.state.lastAction + ' @ ' + timeText(daemon.state.lastActionAt) : '—'),
            kv('dsh 进程', daemon.state && daemon.state.pid ? String(daemon.state.pid) : '—'),
          ),
          daemon.state && daemon.state.lastError
            ? createElement('div', { style: Object.assign({}, S.error, { marginTop: 10, marginBottom: 0 }) }, '守护最近错误：' + daemon.state.lastError)
            : null,
        ),
        createElement(
          'p',
          { style: Object.assign({}, S.hint, { marginTop: 10 }) },
          '网关将执行下面这些命令。守护进程需要独立于 dsh 常驻（见插件包 service/ 下的 systemd / launchd / Windows 服务样例）：',
        ),
        createElement('div', { style: Object.assign({}, S.mono, { marginBottom: 12 }) }, daemon.supervisorCommand || daemon.supervisor || 'daemon.js'),
        DaemonField({ label: '启动脚本', hint: '占位符：{port} dsh 端口、{dshHome} dsh home、{home} 插件数据目录、{pid} 受管子进程 PID；留空则必须填「子进程命令」', value: scripts.start, placeholder: startPh, onChange: function (v) { patchScripts({ start: v }) }, narrow: narrow, rows: 2 }),
        DaemonField({ label: '停止脚本', value: scripts.stop, placeholder: stopPh, onChange: function (v) { patchScripts({ stop: v }) }, narrow: narrow, rows: 2 }),
        DaemonField({ label: '重启脚本（可选）', hint: '留空则用「停止 + 启动」', value: scripts.restart, placeholder: '留空', onChange: function (v) { patchScripts({ restart: v }) }, narrow: narrow, rows: 2 }),
        DaemonField({ label: '状态探测脚本（可选）', hint: '退出码 0 表示 dsh 正在运行；用于识别脚本模式下的意外退出', value: scripts.status, placeholder: statusPh, onChange: function (v) { patchScripts({ status: v }) }, narrow: narrow, rows: 2 }),
        DaemonField({ label: '子进程命令（可选，优先于启动脚本）', hint: '由守护进程直接 spawn 为受管子进程，可精确停止（SIGTERM → SIGKILL）', value: child.command, placeholder: 'dsh web --port {port}', onChange: function (v) { patchChild({ command: v }) }, narrow: narrow, rows: 2 }),
        createElement(
          'div',
          { style: S.kv },
          kv('平台', isWin ? 'Windows' : 'POSIX'),
          kv('shell', scripts.shell || (isWin ? 'cmd' : 'sh')),
        ),
        createElement(
          'div',
          // 保存按钮单独成区：与上方表单留出明显间距，避免贴着字段。
          // 注意必须包在 { style: … } 里：直接传样式对象会被当成 HTML 属性，样式静默失效。
          {
            style: narrow
              ? Object.assign({}, S.row, { flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 16 })
              : Object.assign({}, S.row, { marginTop: 16 }),
          },
          createElement('button', { onClick: save, disabled: busy || !remote, style: Object.assign({}, S.primary, busy || !remote ? S.disabled : {}, narrow ? { width: '100%', padding: '11px 14px' } : {}) }, busy ? '保存中…' : '保存守护设置'),
        ),
        error ? createElement('div', { style: S.error }, String(error)) : null,
        notice ? createElement('div', { style: S.notice }, String(notice)) : null,
      )
    }

    function AgentSection(props) {
      var mountPromise = props.mount
      var getRemote = props.getRemote

      var _gateway = useState('')
      var gatewayUrl = _gateway[0]
      var setGatewayUrl = _gateway[1]
      var _pairing = useState('')
      var pairingCode = _pairing[0]
      var setPairingCode = _pairing[1]

      var _remote = useState(null)
      var remote = _remote[0]
      var setRemote = _remote[1]
      var _status = useState(null)
      var status = _status[0]
      var setStatus = _status[1]
      var _err = useState(null)
      var error = _err[0]
      var setError = _err[1]
      var _notice = useState(null)
      var notice = _notice[0]
      var setNotice = _notice[1]
      var _busy = useState(false)
      var busy = _busy[0]
      var setBusy = _busy[1]
      var narrow = useIsNarrow()

      // $mount 就绪后取 remote 命名空间；所有 remote 访问都做防御，绝不抛未捕获异常。
      useEffect(function () {
        var alive = true
        Promise.resolve(mountPromise)
          .then(function () {
            if (!alive) return
            var ns = null
            try {
              ns = getRemote() || null
            } catch (e) {
              ns = null
            }
            setRemote(ns)
          })
          .catch(function (e) {
            if (alive) setError('Remote 命名空间挂载失败：' + (e && e.message ? e.message : String(e)))
          })
        return function () {
          alive = false
        }
      }, [mountPromise, getRemote])

      // remote 就绪后轮询状态；任何异常都只落到 setError，不会打断渲染。
      useEffect(function () {
        if (!remote) return
        var alive = true
        function poll() {
          if (!alive) return
          try {
            Promise.resolve(remoteCall(remote, 'status', []))
              .then(function (r) {
                if (!alive) return
                var v = unwrap(r)
                if (v.error) setError(v.error)
                else setStatus(v)
              })
              .catch(function (e) {
                if (alive) setError(String(e && e.message ? e.message : e))
              })
          } catch (e) {
            if (alive) setError(String(e && e.message ? e.message : e))
          }
        }
        poll()
        var timer = setInterval(poll, 3000)
        return function () {
          alive = false
          clearInterval(timer)
        }
      }, [remote])

      function doOnboard() {
        if (!remote) return setError('客户端尚未就绪')
        if (!gatewayUrl) return setError('请填写网关地址')
        if (!pairingCode) return setError('请填写配对码')
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          withTimeout(Promise.resolve(remoteCall(remote, 'onboard', [gatewayUrl, pairingCode])), 15000).then(
            function (r) {
              setBusy(false)
              var v = unwrap(r)
              if (v.error) setError(v.error)
              else {
                setNotice('已发起入网申请，正在连接网关…')
                setStatus(v)
              }
            },
            function (e) {
              setBusy(false)
              setError(String(e && e.message ? e.message : e))
            },
          )
        } catch (e) {
          setBusy(false)
          setError(String(e && e.message ? e.message : e))
        }
      }

      function doRefresh() {
        if (!remote) return setError('客户端尚未就绪')
        setError(null)
        try {
          Promise.resolve(remoteCall(remote, 'status', [])).then(
            function (r) {
              var v = unwrap(r)
              if (v.error) setError(v.error)
              else setStatus(v)
            },
            function (e) {
              setError(String(e && e.message ? e.message : e))
            },
          )
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        }
      }

      var meta = status ? stateMeta(status.state) : null

      function field(label, placeholder, value, onChange) {
        return createElement(
          'label',
          { style: S.field },
          createElement('span', { style: S.fieldLabel }, label),
          createElement('input', {
            type: 'text',
            value: value,
            placeholder: placeholder,
            spellCheck: false,
            onChange: function (e) { onChange(e.target.value) },
            // 窄屏输入框提升到 16px，避免 iOS 聚焦自动放大页面（focus zoom）。
            style: narrow ? Object.assign({}, S.input, { fontSize: 16, padding: '9px 12px' }) : S.input,
          }),
        )
      }

      // 页签：网关接入 / 守护进程服务。两块都保持挂载，用 display 切换，
      // 这样切走再切回来不会重置正在编辑的表单。
      var _tab = useState('gateway')
      var tab = _tab[0]
      var setTab = _tab[1]
      var daemonStatus = status && status.daemon ? status.daemon : null
      var daemonState = daemonStatus && daemonStatus.state ? daemonStatus.state.state : ''
      // 页签上的小圆点跟状态卡片用同一套判断：守护进程不在时 daemon-state.json 里那个
      // running 只是历史值，圆点必须是灰的「离线」，不能一直绿。
      var daemonTabMeta = !daemonStatus
        ? null
        : !(daemonStatus.state && daemonStatus.state.supervisorPid) || daemonStatus.supervisorAlive === false
          ? { label: '离线', color: '#8b8f98' }
          : daemonState
            ? daemonMeta(daemonState, daemonStatus.state.lastAction)
            : null

      function tabButton(id, label, badge) {
        var active = tab === id
        return createElement(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': active,
            onClick: function () { setTab(id) },
            style: Object.assign({}, S.tab, active ? S.tabActive : {}),
          },
          label,
          badge ? createElement('span', { style: Object.assign({}, S.tabDot, { background: badge.color }), title: badge.label }) : null,
        )
      }

      return createElement(
        'div',
        { style: S.wrap },
        createElement(
          'div',
          { style: S.tabs, role: 'tablist' },
          tabButton('gateway', '网关接入', meta),
          daemonStatus ? tabButton('daemon', '守护进程服务', daemonTabMeta) : null,
        ),
        createElement(
          'div',
          { style: Object.assign({}, S.pane, tab === 'gateway' ? null : S.hidden) },
          createElement('p', { style: S.desc }, '把本机 dsh 接入网关：填网关地址（协议 + 服务器地址，如 ws://127.0.0.1:3300）与配对码，发起入网申请后由管理员在网关审批。'),
          field('网关地址', 'ws://127.0.0.1:3300', gatewayUrl, setGatewayUrl),
          field('配对码（管理员签发）', '一次性配对码', pairingCode, setPairingCode),
          createElement(
            'div',
            // 窄屏下按钮改为纵向全宽排列；宽屏保持并排。
            { style: narrow ? Object.assign({}, S.row, { flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 8 }) : S.row },
            createElement('button', { onClick: doOnboard, disabled: busy || !remote, style: Object.assign({}, S.primary, busy || !remote ? S.disabled : {}, narrow ? { width: '100%', padding: '11px 14px' } : {}) }, busy ? '发起中…' : '发起入网申请'),
            createElement('button', { onClick: doRefresh, disabled: !remote, style: Object.assign({}, S.btn, !remote ? S.disabled : {}, narrow ? { width: '100%', padding: '11px 14px' } : {}) }, '查询状态'),
          ),
          error ? createElement('div', { style: S.error }, String(error)) : null,
          notice ? createElement('div', { style: S.notice }, String(notice)) : null,
          meta
            ? createElement(
                'div',
                // 同前：样式必须包在 { style: … } 里，否则边框/内边距全部失效。
                { style: narrow ? Object.assign({}, S.statusCard, { padding: 10 }) : S.statusCard },
                createElement(
                  'div',
                  { style: S.statusHead },
                  createElement('span', { style: Object.assign({}, S.dot, { background: meta.color }) }),
                  createElement('strong', { style: { color: meta.color, fontSize: 14 } }, meta.label),
                ),
                createElement(
                  'div',
                  { style: S.kv },
                  kv('网关地址', status.gatewayUrl || '—'),
                  kv('机器 ID', status.machineId || '—'),
                  kv('状态', status.state),
                  kv('已发节点密钥', status.hasNodeKey ? '是' : '否'),
                  kv('dsh 版本', status.dshVersion || '—'),
                  kv('RTT', status.rttMs != null ? status.rttMs + ' ms' : '—'),
                ),
                status.lastError ? createElement('div', { style: Object.assign({}, S.error, { marginTop: 10 }) }, '最近错误：' + status.lastError) : null,
              )
            : null,
        ),
        daemonStatus
          ? createElement(
              'div',
              { style: Object.assign({}, S.pane, tab === 'daemon' ? null : S.hidden) },
              createElement(DaemonSection, { remote: remote, status: status, getRemote: getRemote, tabbed: true }),
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'remote'],
      apply: function (ctx) {
        var mountPromise = ctx.remote.$mount({ package: PACKAGE, descriptors: INVOCATIONS })
        var getRemote = function () {
          try {
            return ctx.get('remote.' + NAMESPACE)
          } catch (e) {
            return null
          }
        }

        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: PACKAGE, order: 100, label: '网关接入' },
            function () {
              return createElement(AgentSection, { mount: mountPromise, getRemote: getRemote })
            },
          )
        })
      },
    }
  },
})

})()
