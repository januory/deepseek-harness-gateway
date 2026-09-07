import { useCallback, useEffect, useState } from 'react'
import { api, type AuditFilters } from '../api'
import type { AuditEvent, PublicUser } from '../types'
import { AUDIT_ACTIONS } from '../types'
import { Button, Card, Empty, PageHeader, ResultBadge, Spinner, formatTime, shortId } from '../ui'

export function AuditView({ me }: { me: PublicUser }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [machineId, setMachineId] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [result, setResult] = useState('')
  const [err, setErr] = useState<string | null>(null)

  // Same optional filters drive the list and the manual export (ADR-0012 §C/D).
  const filters = useCallback(
    (): AuditFilters => ({
      machineId: machineId.trim() || undefined,
      since: since || undefined,
      until: until || undefined,
      actor: actor.trim() || undefined,
      action: action.trim() || undefined,
      result: result || undefined,
    }),
    [machineId, since, until, actor, action, result],
  )

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api.audit(filters())
      setEvents(r.events)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [filters])

  useEffect(() => {
    void load()
  }, [load])

  const exportFile = (format: 'jsonl' | 'csv') => {
    // Same-origin anchor download: the gateway's Content-Disposition header
    // names the file, and the session cookie travels automatically.
    const a = document.createElement('a')
    a.href = api.auditExportHref(format, filters())
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div className="audit-view">
      <PageHeader
        title="审计"
        desc="谁在何时控制/操作了哪台机器（正文永不落盘）；默认保留 30 天，过期自动清理"
        actions={
          <>
            <Button variant="ghost" onClick={() => exportFile('jsonl')}>
              导出 JSONL
            </Button>
            <Button variant="ghost" onClick={() => exportFile('csv')}>
              导出 CSV
            </Button>
            <Button onClick={() => void load()}>刷新</Button>
          </>
        }
      />

      <Card title="筛选">
        <div className="form-grid">
          <div className="field">
            <span className="field__label">机器 ID（精确）</span>
            <input
              className="input"
              placeholder="可选"
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
            />
          </div>
          <div className="field">
            <span className="field__label">操作者</span>
            <input className="input" placeholder="可选" value={actor} onChange={(e) => setActor(e.target.value)} />
          </div>
          <div className="field">
            <span className="field__label">动作</span>
            <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">全部</option>
              {AUDIT_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field__label">结果</span>
            <select className="select" value={result} onChange={(e) => setResult(e.target.value)}>
              <option value="">全部</option>
              <option value="ok">成功 (ok)</option>
              <option value="denied">拒绝 (denied)</option>
              <option value="error">错误 (error)</option>
            </select>
          </div>
          <div className="field">
            <span className="field__label">起始时间</span>
            <input className="input" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
          </div>
          <div className="field">
            <span className="field__label">截止时间</span>
            <input className="input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
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
          <>
            {/* Wide screens: the full 5-column table (kept scrollable on its own). */}
            <div className="audit-table card__body card__body--flush">
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
            {/* Phones/tablets: one stacked card per event (mirrors machines-cards). */}
            <div className="audit-cards">
              {events.map((e, i) => (
                <div className="audit-card" key={`c-${e.ts}:${i}`}>
                  <div className="audit-card__head">
                    <span className="muted">{formatTime(e.ts)}</span>
                    <ResultBadge result={e.result} />
                  </div>
                  <div className="audit-card__row">
                    <span className="audit-card__label">操作者</span>
                    <strong className="audit-card__value">{e.actor}</strong>
                  </div>
                  <div className="audit-card__row">
                    <span className="audit-card__label">动作</span>
                    <span className="mono audit-card__value">{e.action}</span>
                  </div>
                  <div className="audit-card__row">
                    <span className="audit-card__label">机器</span>
                    <span className="mono muted audit-card__value">{e.machineId ? shortId(e.machineId) : '—'}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
