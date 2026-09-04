import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { PublicUser, UpdateStatus, VersionInfo } from '../types'
import { Button, Card, Empty, PageHeader, Spinner, useToast } from '../ui'

export function SettingsView({ me }: { me: PublicUser }) {
  const isSystemAdmin = me.role === 'system-admin'
  const toast = useToast()

  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [check, setCheck] = useState<UpdateStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)

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
      await load()
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setUpdating(false)
    }
  }

  const head = info?.head
  const hasGit = info?.git !== false
  const behind = check?.behind ?? 0
  const canUpdate = isSystemAdmin && hasGit && behind > 0 && !(info?.dirty ?? false) && !updating

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
          <Empty>镜像内未打包 git 仓库（未指定源码路径），不可热更新</Empty>
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
            未指定源码仓库（DSH_GATEWAY_GIT_REPO），容器使用镜像内打包的源码运行，无法热更新。
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
              {info?.dirty ? <span className="badge badge--red">工作区有改动，无法安全更新</span> : null}
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

            <div style={{ marginTop: 14 }}>
              <Button variant="danger" disabled={!canUpdate} onClick={() => void doUpdate()}>
                {updating ? '更新中…' : isSystemAdmin ? '更新到最新' : '仅系统管理员可更新'}
              </Button>
            </div>
          </>
        )}
      </Card>
    </>
  )
}
