import { useState } from 'react'
import { api } from '../api'
import type { PublicUser } from '../types'
import whaleMark from '../assets/whale-mark.svg'

const GITHUB_URL = 'https://github.com/januory/deepseek-harness-gateway'

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

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
      <form className="login-card" onSubmit={submit} noValidate>
        <div className="login-brand">
          <img className="login-brand__logo" src={whaleMark} alt="" width={64} height={64} />
          <h1 className="login-title">deepseek-harness-gateway</h1>
          <p className="login-sub">受管网关路由器 · 登录控制台</p>
        </div>

        <label className="login-field">
          <span className="login-field__label">账号</span>
          <input
            className="input login-input"
            placeholder="请输入账号"
            value={id}
            onChange={(e) => setId(e.target.value)}
            autoFocus
            autoComplete="username"
            spellCheck={false}
          />
        </label>

        <label className="login-field">
          <span className="login-field__label">密码</span>
          <input
            className="input login-input"
            type="password"
            placeholder="请输入密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {err ? <div className="login-error">{err}</div> : null}

        <button className="login-submit" type="submit" disabled={busy || !id || !password}>
          {busy ? (
            <>
              <span className="login-submit__spinner" aria-hidden="true" />
              登录中…
            </>
          ) : (
            '登录'
          )}
        </button>

        <a className="login-github" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          <GitHubMark />
          在 GitHub 上查看源码
        </a>
      </form>
      <div className="login-foot">
        deepseek-harness-gateway · 多租户受管网关路由器
      </div>
    </div>
  )
}
