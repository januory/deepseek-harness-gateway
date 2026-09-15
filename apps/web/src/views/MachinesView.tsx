import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { DaemonState, MachineView, PublicUser } from '../types'
import { Button, Card, Empty, Field, Modal, PageHeader, Spinner, StatusBadge, StatusDot, formatTime, shortId, useToast } from '../ui'

type Filter = 'all' | 'approved' | 'pending' | 'revoked'

/** dsh lifecycle label/colour as reported by the machine's own supervisor. */
function daemonMeta(state: DaemonState): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  switch (state) {
    case 'running':
      return { label: 'dsh 运行中', tone: 'ok' }
    case 'starting':
      return { label: '处理中…', tone: 'warn' }
    case 'stopped':
      return { label: 'dsh 已关闭', tone: 'muted' }
    case 'exited':
      return { label: 'dsh 已退出', tone: 'bad' }
    case 'unknown':
      return { label: '状态未知', tone: 'warn' }
    default:
      return { label: '未接入守护', tone: 'muted' }
  }
}

/** Daemon lifecycle badge. Renders nothing for machines without supervision. */
function DaemonBadge({ m }: { m: MachineView }) {
  if (!m.supervisorConnected && !m.daemonEnabled && !m.daemonState) return null
  const meta = daemonMeta(m.daemonState)
  const offline = !m.supervisorConnected
  return (
    <span className={`daemon-badge daemon-badge--${offline ? 'offline' : meta.tone}`} title={
      offline
        ? '守护进程未连接：无法远程启停 dsh，显示的是最后一次上报的状态'
        : '由机器上的守护进程上报'
    }>
      <span className="daemon-badge__dot" />
      {meta.label}
      {offline ? ' ·离线' : ''}
    </span>
  )
}

export function MachinesView({ me, onOpenConsole }: { me: PublicUser; onOpenConsole: (m: MachineView) => void }) {
  const isAdmin = me.role !== 'user'
  const toast = useToast()

  const [machines, setMachines] = useState<MachineView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'delete'; m: MachineView } | null>(null)
  const [edit, setEdit] = useState<{ m: MachineView; name: string } | null>(null)
  const [daemonConfirm, setDaemonConfirm] = useState<{ action: 'start' | 'stop' | 'restart'; m: MachineView } | null>(null)

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

  // While an action is in flight the machine reports `starting`; poll a little
  // faster so the badge settles quickly without a manual refresh.
  useEffect(() => {
    if (!machines) return
    const pending = machines.some((m) => m.daemonState === 'starting')
    if (!pending) return
    const timer = setInterval(() => void load(), 2000)
    return () => clearInterval(timer)
  }, [machines, load])

  const visible = useMemo(() => {
    if (!machines) return []
    const q = query.trim().toLowerCase()
    return machines.filter((m) => {
      if (filter !== 'all' && m.status !== filter) return false
      if (q && !(m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))) return false
      return true
    })
  }, [machines, filter, query])

  async function run(m: MachineView, fn: () => Promise<unknown>, okMessage = '操作成功') {
    setBusy(m.id)
    try {
      await fn()
      toast('ok', okMessage)
      await load()
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setBusy(null)
    }
  }

  function openConsole(m: MachineView) {
    // Assignment is the permission (no console-seat acquire step).
    onOpenConsole(m)
  }

  /** Daemon controls: only admins, only while a supervisor is connected. */
  function renderDaemonActions(m: MachineView) {
    if (!isAdmin || !m.supervisorConnected) return null
    const disabled = busy === m.id
    const running = m.daemonState === 'running' || m.daemonState === 'starting'
    return (
      <>
        {!running && (
          <Button
            variant="default"
            disabled={disabled}
            title="通过机器上的守护进程启动 dsh"
            onClick={() => void run(m, () => api.daemonStart(m.id), '已下发启动指令')}
          >
            启动
          </Button>
        )}
        {running && (
          <Button
            variant="default"
            disabled={disabled}
            title="停止 dsh（守护进程仍在线，可再次启动）"
            onClick={() => setDaemonConfirm({ action: 'stop', m })}
          >
            关闭
          </Button>
        )}
        <Button
          variant="default"
          disabled={disabled}
          title="重启 dsh"
          onClick={() => setDaemonConfirm({ action: 'restart', m })}
        >
          重启
        </Button>
      </>
    )
  }

  function renderActions(m: MachineView) {
    return (
      <>
        {m.status === 'approved' && (
          <>
            <Button variant="primary" onClick={() => openConsole(m)}>
              控制台
            </Button>
          </>
        )}
        {isAdmin && m.status === 'pending' && (
          <Button variant="primary" disabled={busy === m.id} onClick={() => void run(m, () => api.approveMachine(m.id))}>
            批准
          </Button>
        )}
        {renderDaemonActions(m)}
        {isAdmin && (
          <Button variant="default" disabled={busy === m.id} onClick={() => setEdit({ m, name: m.name })}>
            编辑
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
                    <th>dsh 生命周期</th>
                    <th>最后心跳</th>
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
                        {/* Name + id on one line (same as the assignments table) so
                            the row is a single height and the badge/version/heartbeat/
                            actions line up on the same top line. */}
                        <span style={{ fontWeight: 600 }}>{m.name}</span>{' '}
                        <span className="mono muted" title={m.id}>
                          {shortId(m.id)}
                        </span>
                      </td>
                      {/* Same style as the heartbeat cell so both metadata columns
                          share one baseline (the mono 12.5px glyph sits ~1px off). */}
                      <td className="muted">{m.dshVersion || '—'}</td>
                      <td className="muted">
                        <DaemonBadge m={m} />
                      </td>
                      <td className="muted">{formatTime(m.lastHeartbeatAt)}</td>
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
                    <DaemonBadge m={m} />
                    <span>最后心跳 {formatTime(m.lastHeartbeatAt)}</span>
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

      {/* Daemon lifecycle confirmation: stopping dsh kills remote consoles, so it
          is not something to trigger with a stray click. */}
      <Modal
        open={daemonConfirm !== null}
        title={daemonConfirm?.action === 'stop' ? '关闭 dsh' : '重启 dsh'}
        confirmLabel={daemonConfirm?.action === 'stop' ? '关闭' : '重启'}
        danger={daemonConfirm?.action === 'stop'}
        onClose={() => setDaemonConfirm(null)}
        onConfirm={() => {
          if (!daemonConfirm) return
          const { action, m } = daemonConfirm
          setDaemonConfirm(null)
          const call =
            action === 'stop' ? () => api.daemonStop(m.id) : action === 'restart' ? () => api.daemonRestart(m.id) : () => api.daemonStart(m.id)
          void run(m, call, action === 'stop' ? '已下发关闭指令' : '已下发重启指令')
        }}
      >
        {daemonConfirm ? (
          <p style={{ margin: 0 }}>
            {daemonConfirm.action === 'stop' ? (
              <>
                确定关闭机器 <strong>{daemonConfirm.m.name}</strong>（<span className="mono">{shortId(daemonConfirm.m.id)}</span>）上的 dsh？
                正在使用该机器控制台的人会立刻断开；守护进程仍在线，可以再次「启动」。
              </>
            ) : (
              <>
                确定重启机器 <strong>{daemonConfirm.m.name}</strong>（<span className="mono">{shortId(daemonConfirm.m.id)}</span>）上的 dsh？
                正在进行的会话会短暂中断。
              </>
            )}
          </p>
        ) : null}
      </Modal>

      {/* Machine edit: the name is the only editable field; the rest is read-only metadata. */}
      <Modal
        open={edit !== null}
        title="编辑机器"
        confirmLabel="保存"
        onClose={() => setEdit(null)}
        onConfirm={() => {
          if (!edit) return
          const name = edit.name.trim()
          if (!name) {
            toast('error', '名称不能为空')
            return
          }
          const { m } = edit
          setEdit(null)
          void run(m, () => api.renameMachine(m.id, name))
        }}
      >
        {edit ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>
                机器 ID
              </span>
              <span className="mono" style={{ fontSize: 13 }}>
                {edit.m.id}
              </span>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                <StatusBadge status={edit.m.status} /> · dsh {edit.m.dshVersion || '—'} · 创建于 {formatTime(edit.m.createdAt)}
              </div>
            </div>
            <Field label="名称">
              <input
                className="input"
                value={edit.name}
                maxLength={64}
                placeholder="机器名称"
                spellCheck={false}
                autoFocus
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <div className="muted" style={{ fontSize: 12.5 }}>
              守护进程：{edit.m.supervisorConnected ? `在线（${daemonMeta(edit.m.daemonState).label}）` : '离线'} ·{' '}
              {edit.m.daemonEnabled ? '服务已启用' : '服务未启用'}
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  )
}
