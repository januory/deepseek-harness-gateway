import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { AuditEvent, PublicUser, Tenant } from '../types'
import { Button, Card, Empty, PageHeader, ResultBadge, Spinner, formatTime, shortId } from '../ui'

export function AuditView({ me }: { me: PublicUser }) {
  const isPlatformAdmin = me.role === 'platform-admin'

  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [tenantFilter, setTenantFilter] = useState(me.tenantId)
  const [machineFilter, setMachineFilter] = useState('')
  const [since, setSince] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api.audit({
        tenantId: isPlatformAdmin ? tenantFilter : undefined,
        machineId: machineFilter.trim() || undefined,
        since: since || undefined,
      })
      setEvents(r.events)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [isPlatformAdmin, tenantFilter, machineFilter, since])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (isPlatformAdmin) {
      api
        .tenants()
        .then((r) => setTenants(r.tenants))
        .catch(() => {})
    }
  }, [isPlatformAdmin])

  return (
    <>
      <PageHeader
        title="审计"
        desc="谁在何时控制/操作了哪台机器（正文永不落盘）"
        actions={<Button onClick={() => void load()}>刷新</Button>}
      />

      <Card title="筛选">
        <div className="form-grid">
          {isPlatformAdmin ? (
            <div className="field">
              <span className="field__label">租户</span>
              <select className="select" value={tenantFilter} onChange={(e) => setTenantFilter(e.target.value)}>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <span className="field__label">机器 ID（前缀）</span>
            <input className="input" placeholder="可选" value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)} />
          </div>
          <div className="field">
            <span className="field__label">起始时间</span>
            <input className="input" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
          </div>
        </div>
      </Card>

      {err ? <div className="login-error">{err}</div> : null}

      <Card title={`事件（${events?.length ?? 0}）`}>
        {events === null ? (
          <Spinner />
        ) : events.length === 0 ? (
          <Empty>暂无审计事件</Empty>
        ) : (
          <div className="card__body card__body--flush">
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>动作</th>
                  <th>机器</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={`${e.ts}:${i}`}>
                    <td className="muted">{formatTime(e.ts)}</td>
                    <td style={{ fontWeight: 600 }}>{e.actor}</td>
                    <td className="mono">{e.action}</td>
                    <td className="mono muted">{e.machineId ? shortId(e.machineId) : '—'}</td>
                    <td>
                      <ResultBadge result={e.result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
