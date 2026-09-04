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
var PACKAGE = 'dsh-gateway-agent'
var NAMESPACE = 'gatewayAgent'

var JSON_CODEC = Object.freeze({
  mode: 'strict',
  typeSymbol: 'JsonValue',
  schema: Object.freeze({ parse: function (value) { return value } }),
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

window.__ModuleLoader__.load({
  id: PACKAGE,
  factory: function (require) {
    var React = require('react')
    var createElement = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var S = {
      wrap: { padding: 16, fontSize: 14, lineHeight: 1.6, maxWidth: 720, color: 'inherit' },
      title: { fontWeight: 600, fontSize: 16, margin: '0 0 4px', color: 'inherit' },
      desc: { margin: '0 0 14px', color: '#8b8f98', fontSize: 13 },
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
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 },
      kv: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 12px', fontSize: 12.5 },
      kvKey: { color: '#8b8f98' },
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

      function withTimeout(promise, ms) {
        return Promise.race([
          promise,
          new Promise(function (_resolve, reject) {
            setTimeout(function () { reject(new Error('调用超时（' + ms / 1000 + 's）')) }, ms)
          }),
        ])
      }

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
            style: S.input,
          }),
        )
      }

      return createElement(
        'div',
        { style: S.wrap },
        createElement('div', { style: S.title }, '网关接入'),
        createElement('p', { style: S.desc }, '把本机 dsh 接入网关：填网关地址（协议 + 服务器地址，如 ws://127.0.0.1:3300）与配对码，发起入网申请后由管理员在网关审批。'),
        field('网关地址', 'ws://127.0.0.1:3300', gatewayUrl, setGatewayUrl),
        field('配对码（管理员签发）', '一次性配对码', pairingCode, setPairingCode),
        createElement(
          'div',
          { style: S.row },
          createElement('button', { onClick: doOnboard, disabled: busy || !remote, style: Object.assign({}, S.primary, busy || !remote ? S.disabled : {}) }, busy ? '发起中…' : '发起入网申请'),
          createElement('button', { onClick: doRefresh, disabled: !remote, style: Object.assign({}, S.btn, !remote ? S.disabled : {}) }, '查询状态'),
        ),
        error ? createElement('div', { style: S.error }, String(error)) : null,
        notice ? createElement('div', { style: S.notice }, String(notice)) : null,
        meta
          ? createElement(
              'div',
              { style: S.statusCard },
              createElement(
                'div',
                { style: S.statusHead },
                createElement('span', { style: Object.assign({}, S.dot, { background: meta.color }) }),
                createElement('strong', { style: { color: meta.color, fontSize: 14 } }, meta.label),
              ),
              createElement(
                'div',
                { style: S.kv },
                kv('机器 ID', status.machineId || '—'),
                kv('状态', status.state),
                kv('已发节点密钥', status.hasNodeKey ? '是' : '否'),
                kv('dsh 版本', status.dshVersion || '—'),
                kv('RTT', status.rttMs != null ? status.rttMs + ' ms' : '—'),
              ),
              status.lastError ? createElement('div', { style: Object.assign({}, S.error, { marginTop: 10 }) }, '最近错误：' + status.lastError) : null,
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
