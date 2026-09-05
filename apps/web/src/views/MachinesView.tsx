import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { MachineView, PublicUser } from '../types'
import { Button, Card, Empty, Modal, PageHeader, Spinner, StatusBadge, StatusDot, formatTime, shortId, useToast } from '../ui'

type Filter = 'all' | 'approved' | 'pending' | 'revoked'

export function MachinesView({ me, onOpenConsole }: { me: PublicUser; onOpenConsole: (m: MachineView) => void }) {
  const isAdmin = me.role !== 'user'
  const toast = useToast()

  const [machines, setMachines] = useState<MachineView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'delete'; m: MachineView } | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api.machines()
      setMachines(r.machines)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(() => {
    if (!machines) return []
    const q = query.trim().toLowerCase()
    return machines.filter((m) => {
      if (filter !== 'all' && m.status !== filter) return false
      if (q && !(m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))) return false
      return true
    })
  }, [machines, filter, query])

  async function run(m: MachineView, fn: () => Promise<unknown>) {
    setBusy(m.id)
    try {
      await fn()
      toast('ok', '操作成功')
      await load()
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setBusy(null)
    }
  }

  function openConsole(m: MachineView) {
    void run(m, async () => {
      await api.acquireSeat(m.id)
      onOpenConsole(m)
    })
  }

  function renderActions(m: MachineView) {
    const mySeat = m.seat?.userId === me.id
    return (
      <>
        {m.status === 'approved' && (
          <>
            <Button variant="primary" disabled={busy === m.id} onClick={() => openConsole(m)}>
              控制台
            </Button>
            {mySeat && (
              <Button variant="default" disabled={busy === m.id} onClick={() => void run(m, () => api.releaseSeat(m.id))}>
                释放
              </Button>
            )}
          </>
        )}
        {isAdmin && m.status === 'pending' && (
          <Button variant="primary" disabled={busy === m.id} onClick={() => void run(m, () => api.approveMachine(m.id))}>
            批准
          </Button>
        )}
        {isAdmin && m.status === 'approved' && (
          <Button variant="default" disabled={busy === m.id} onClick={() => setConfirm({ kind: 'revoke', m })}>
            吊销
          </Button>
        )}
        {isAdmin && (
          <Button variant="danger" disabled={busy === m.id} onClick={() => setConfirm({ kind: 'delete', m })}>
            删除
          </Button>
        )}
      </>
    )
  }

  function seatLabel(m: MachineView) {
    const mySeat = m.seat?.userId === me.id
    return m.seat ? (
      <>
        {m.seat.userId}
        {mySeat ? '（你）' : ''}
      </>
    ) : (
      '空闲'
    )
  }

  return (
    <>
      <PageHeader
        title="机器目录"
        desc={isAdmin ? '批准、吊销并管理所有接入的节点机器' : '查看并操作分配给你的机器'}
        actions={<Button onClick={() => void load()}>刷新</Button>}
      />

      <div className="card">
        <div className="card__body">
          <div className="machines-toolbar">
            <input
              className="input"
              placeholder="按名称或 ID 搜索…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select className="select" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">全部状态</option>
              <option value="approved">已批准</option>
              <option value="pending">待批准</option>
              <option value="revoked">已吊销</option>
            </select>
          </div>
        </div>
      </div>

      {err ? <div className="login-error">{err}</div> : null}

      <Card>
        {machines === null ? (
          <Spinner />
        ) : visible.length === 0 ? (
          <Empty>{machines.length === 0 ? '暂无机器，等待节点接入' : '没有匹配的机器'}</Empty>
        ) : (
          <>
            {/* Desktop: table */}
            <div className="machines-table card__body card__body--flush">
              <table className="table">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>机器</th>
                    <th>版本</th>
                    <th>最后心跳</th>
                    <th>席位</th>
                    <th style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <StatusDot online={m.online} />
                          <StatusBadge status={m.status} />
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{m.name}</div>
                        <div className="mono muted" title={m.id}>
                          {shortId(m.id)}
                        </div>
                      </td>
                      <td className="mono muted">{m.dshVersion || '—'}</td>
                      <td className="muted">{formatTime(m.lastHeartbeatAt)}</td>
                      <td className="muted">{seatLabel(m)}</td>
                      <td className="cell-actions">{renderActions(m)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: cards */}
            <div className="machines-cards">
              {visible.map((m) => (
                <div className="machine-card" key={m.id}>
                  <div className="machine-card__head">
                    <div className="machine-card__title">
                      <StatusDot online={m.online} />
                      <strong title={m.name}>{m.name}</strong>
                      <StatusBadge status={m.status} />
                    </div>
                    <span className="mono muted" title={m.id}>
                      {shortId(m.id)}
                    </span>
                  </div>
                  <div className="machine-card__meta">
                    <span>版本 {m.dshVersion || '—'}</span>
                    <span>最后心跳 {formatTime(m.lastHeartbeatAt)}</span>
                    <span>席位 {seatLabel(m)}</span>
                  </div>
                  <div className="machine-card__actions">{renderActions(m)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Modal
        open={confirm !== null}
        title={confirm?.kind === 'revoke' ? '吊销机器' : '删除机器'}
        confirmLabel={confirm?.kind === 'revoke' ? '吊销' : '删除'}
        danger
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return
          const { kind, m } = confirm
          setConfirm(null)
          void run(m, () => (kind === 'revoke' ? api.revokeMachine(m.id) : api.deleteMachine(m.id)))
        }}
      >
        {confirm ? (
          <p style={{ margin: 0 }}>
            {confirm.kind === 'revoke' ? (
              <>
                确定吊销机器 <strong>{confirm.m.name}</strong>（<span className="mono">{shortId(confirm.m.id)}</span>）？吊销后节点将断开连接。
              </>
            ) : (
              <>
                确定删除机器 <strong>{confirm.m.name}</strong>（<span className="mono">{shortId(confirm.m.id)}</span>）？此操作不可撤销。
              </>
            )}
          </p>
        ) : null}
      </Modal>
    </>
  )
}
