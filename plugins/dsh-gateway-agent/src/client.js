// dsh-gateway-agent — client half（浏览器面）。
//
// 以 classic factory 经 window.__ModuleLoader__ 自注册（无 ESM import/export），
// react 是平台 seed word。提供"网关接入"设置卡：网关地址、入网申请、连接状态。
// Remote 契约与 src/index.js 逐字镜像（must match）。

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

function unwrap(res) {
  if (res && res.ok === false) {
    return { error: res.error && res.error.message ? res.error.message : '远程调用失败' }
  }
  return { value: res && res.value }
}

window.__ModuleLoader__.load({
  id: PACKAGE,
  factory: function (require) {
    var React = require('react')
    var createElement = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    function AgentSection(props) {
      var mountPromise = props.mount
      var getRemote = props.getRemote

      var _gateway = useState('')
      var gatewayUrl = _gateway[0]
      var setGatewayUrl = _gateway[1]
      var _pairing = useState('')
      var pairingCode = _pairing[0]
      var setPairingCode = _pairing[1]

      var _status = useState(null)
      var status = _status[0]
      var setStatus = _status[1]
      var _err = useState(null)
      var error = _err[0]
      var setError = _err[1]

      useEffect(function () {
        mountPromise.then(function (ns) {
          getRemote = ns
        })
      }, [mountPromise])

      function doStatus() {
        if (!getRemote) return setError('客户端尚未就绪')
        getRemote
          .status()
          .then(function (r) {
            var u = unwrap(r)
            if (u.error) setError(u.error)
            else {
              setError(null)
              setStatus(u.value)
            }
          })
          .catch(function (e) {
            setError(String(e))
          })
      }

      function doOnboard() {
        if (!getRemote) return setError('客户端尚未就绪')
        getRemote
          .onboard(gatewayUrl, pairingCode)
          .then(function (r) {
            var u = unwrap(r)
            if (u.error) setError(u.error)
            else {
              setError(null)
              setStatus(u.value)
            }
          })
          .catch(function (e) {
            setError(String(e))
          })
      }

      return createElement(
        'div',
        { className: 'dsh-gateway-agent-section' },
        createElement('p', null, '客户机接入插件：填网关地址并发起入网申请（P0 骨架，管理员在网关审批）。'),
        createElement(
          'div',
          { style: { marginBottom: 8 } },
          createElement('input', {
            placeholder: '网关地址，如 wss://gateway.example.com/agent',
            value: gatewayUrl,
            style: { width: '100%' },
            onChange: function (e) { setGatewayUrl(e.target.value) },
          }),
        ),
        createElement(
          'div',
          { style: { marginBottom: 8 } },
          createElement('input', {
            placeholder: '配对码（管理员签发）',
            value: pairingCode,
            style: { width: '100%' },
            onChange: function (e) { setPairingCode(e.target.value) },
          }),
        ),
        createElement('button', { onClick: doOnboard, style: { marginRight: 8 } }, '发起入网申请'),
        createElement('button', { onClick: doStatus }, '查询状态'),
        error ? createElement('p', { style: { color: 'crimson' } }, String(error)) : null,
        status ? createElement('pre', null, JSON.stringify(status, null, 2)) : null,
      )
    }

    return {
      inject: ['slots', 'remote'],
      apply: function (ctx) {
        var mountPromise = ctx.remote.$mount({ package: PACKAGE, descriptors: INVOCATIONS })

        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: PACKAGE, order: 100, label: '网关接入' },
            function () {
              return createElement(AgentSection, { mount: mountPromise })
            },
          )
        })
      },
    }
  },
})
