import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { PublicUser, UpdateStatus, VersionInfo } from '../types'
import { Button, Card, Empty, PageHeader, Spinner, useToast } from '../ui'

// A hot-update makes the gateway reload itself: the process is restarted (tsx
// watch re-runs on pulled gateway-source files, or the compiled server re-execs)
// and its in-memory sessions are cleared. During that window port 3300 is briefly
// down, so a browser (or a proxy in front of it) can show 502 and the SPA never
// reaches the login page. Poll `/health` until the new process is reachable, then
// hard-reload so the freshly-built portal and the now-invalid session are picked
// up — landing the user on the login page instead of a stale or error screen.
function waitForGatewayUp(timeoutMs = 60_000, pollMs = 750): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const res = await fetch('/health', { credentials: 'same-origin', cache: 'no-store' })
        if (res.ok) return void resolve()
      } catch {
        /* gateway not reachable yet — keep polling */
      }
      if (Date.now() >= deadline) return void resolve()
      setTimeout(tick, pollMs)
    }
    void tick()
  })
}

export function SettingsView({ me }: { me: PublicUser }) {
  const isSystemAdmin = me.role === 'system-admin'
  const toast = useToast()

  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [check, setCheck] = useState<UpdateStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [reloading, setReloading] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setInfo(await api.version())
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function doCheck() {
    setChecking(true)
    setErr(null)
    setCheck(null)
    try {
      setCheck(await api.checkVersion())
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    } finally {
      setChecking(false)
    }
  }

  async function doUpdate() {
    setUpdating(true)
    setErr(null)
    try {
      const r = await api.updateVersion()
      toast('ok', `已更新 ${r.pulled.length} 个提交，服务正在重载…`)
      setCheck(null)
    } catch (e) {
      const err = e as { status?: number; message?: string }
      // A 5xx or a bare network error means the gateway restarted before it could
      // answer (the request was interrupted by the reload), so the update DID get
      // applied and we should recover rather than report failure. A 4xx (e.g. a
      // merge conflict) is a genuine failure — surface it and stop.
      if (err.status === undefined || err.status >= 500) {
        toast('ok', '更新已提交，服务正在重载…')
        setCheck(null)
      } else {
        toast('error', String(err.message ?? e))
        setUpdating(false)
        return
      }
    }
    setUpdating(false)
    // The gateway reloads (in-memory sessions are cleared) → drop to the fresh
    // login page once the new process answers.
    setReloading(true)
    await waitForGatewayUp()
    window.location.reload()
  }

  const head = info?.head
  const hasGit = info?.git !== false
  const behind = check?.behind ?? 0
  const canUpdate = isSystemAdmin && hasGit && behind > 0 && !updating && !reloading

  return (
    <>
      <PageHeader
        title="设置"
        desc="查看 deepseek-harness-gateway 的运行版本，并热更新到最新提交"
        actions={<Button onClick={() => void load()}>刷新</Button>}
      />

      {err ? <div className="login-error">{err}</div> : null}

      <Card title="版本信息">
        {info === null ? (
          <Spinner />
        ) : !info.git ? (
          <Empty>当前源码不是 git 仓库，不可热更新</Empty>
        ) : (
          <dl className="kv">
            <dt>仓库</dt>
            <dd className="mono">{info.repo}</dd>
            <dt>分支</dt>
            <dd>
              <span className="mono">{info.branch || '—'}</span>
            </dd>
            <dt>远程</dt>
            <dd className="mono">{info.remote ?? '（无 origin 远程）'}</dd>
            <dt>当前提交</dt>
            <dd>
              {head ? (
                <div className="mono">
                  <strong>{head.short}</strong> <span className="muted">{head.subject}</span>
                  <div className="muted">
                    {head.author} · {head.date} · {head.hash}
                  </div>
                </div>
              ) : (
                '（无提交）'
              )}
            </dd>
            <dt>工作区</dt>
            <dd>
              {info.dirty ? (
                <span className="badge badge--amber">有未提交改动</span>
              ) : (
                <span className="badge badge--green">干净</span>
              )}
            </dd>
          </dl>
        )}
      </Card>

      <Card
        title="更新"
        actions={
          <Button variant="primary" disabled={checking || !hasGit} onClick={() => void doCheck()}>
            {checking ? '检查中…' : '检查更新'}
          </Button>
        }
      >
        {!hasGit ? (
          <p className="muted" style={{ margin: 0 }}>
            当前源码不是 git 仓库，无法热更新（把 git 仓库挂载到源码目录即可启用）。
          </p>
        ) : check === null ? (
          <p className="muted" style={{ margin: 0 }}>
            点击「检查更新」从 git 远程获取最新提交，查看可更新数量。
          </p>
        ) : behind === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="badge badge--green">已是最新</span>
            {check.ahead > 0 ? (
              <span className="muted">本地领先远程 {check.ahead} 个提交</span>
            ) : null}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span className="badge badge--amber">有 {behind} 个提交可以更新</span>
              {check.ahead > 0 ? <span className="muted">本地还领先 {check.ahead} 个提交</span> : null}
            </div>

            {check.incoming.length === 0 ? (
              <Empty>无法列出待更新提交</Empty>
            ) : (
              <div className="card__body card__body--flush" style={{ margin: '0 -18px -18px' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>提交</th>
                      <th>说明</th>
                      <th>作者</th>
                      <th>日期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.incoming.map((c) => (
                      <tr key={c.hash}>
                        <td className="mono">{c.short}</td>
                        <td style={{ fontWeight: 600 }}>{c.subject}</td>
                        <td className="muted">{c.author}</td>
                        <td className="muted">{c.date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {reloading ? (
              <p className="muted" style={{ marginTop: 10 }}>
                服务正在重载，恢复后自动跳转到登录页…
              </p>
            ) : null}
            <div style={{ marginTop: 14 }}>
              <Button variant="danger" disabled={!canUpdate} onClick={() => void doUpdate()}>
                {reloading ? '服务重载中…' : updating ? '更新中…' : isSystemAdmin ? '更新到最新' : '仅系统管理员可更新'}
              </Button>
            </div>
          </>
        )}
      </Card>
    </>
  )
}
