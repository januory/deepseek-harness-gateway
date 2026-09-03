import { useState } from 'react'
import { api } from '../api'
import type { PublicUser } from '../types'
import { Button, Field } from '../ui'

export function LoginView({ onLogin }: { onLogin: (u: PublicUser) => void }) {
  const [id, setId] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      const { user } = await api.login(id, password)
      onLogin(user)
    } catch (e2) {
      setErr(String((e2 as Error).message ?? e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>deepseek-harness-gateway</h1>
        <div className="sub">多租户受管网关路由器 · 控制台</div>
        <Field label="账号">
          <input
            className="input"
            placeholder="账号"
            value={id}
            onChange={(e) => setId(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </Field>
        <Field label="密码">
          <input
            className="input"
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        {err ? <div className="login-error">{err}</div> : null}
        <Button variant="primary" type="submit" disabled={busy || !id || !password}>
          {busy ? '登录中…' : '登录'}
        </Button>
      </form>
    </div>
  )
}
