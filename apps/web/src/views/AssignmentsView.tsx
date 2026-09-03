import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Assignment, MachineView, PublicUser, Tenant, UserView } from '../types'
import { Button, Card, Empty, Field, PageHeader, Spinner, formatTime, shortId, useToast } from '../ui'

export function AssignmentsView({ me }: { me: PublicUser }) {
  const isPlatformAdmin = me.role === 'platform-admin'
  const toast = useToast()

  const [assignments, setAssignments] = useState<Assignment[] | null>(null)
  const [machines, setMachines] = useState<MachineView[]>([])
  const [users, setUsers] = useState<UserView[]>([])
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [tenantFilter, setTenantFilter] = useState(me.tenantId)
  const [err, setErr] = useState<string | null>(null)

  // assign form
  const [machineId, setMachineId] = useState('')
  const [userId, setUserId] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const [a, m, u] = await Promise.all([
        api.assignments(isPlatformAdmin ? tenantFilter : undefined),
        api.machines(),
        api.users(isPlatformAdmin ? tenantFilter : undefined),
      ])
      setAssignments(a.assignments)
      setMachines(m.machines)
      setUsers(u.users)
      setMachineId((prev) => prev || m.machines[0]?.id || '')
      setUserId((prev) => prev || u.users[0]?.id || '')
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [isPlatformAdmin, tenantFilter])

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

  const machineName = useCallback(
    (id: string) => machines.find((m) => m.id === id)?.name ?? shortId(id),
    [machines],
  )

  async function assign() {
    if (!machineId || !userId) {
      toast('error', '请选择机器与用户')
      return
    }
    setBusy(true)
    try {
      await api.assign(machineId, userId)
      toast('ok', '已分配')
      await load()
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function unassign(machine: string, user: string) {
    try {
      await api.unassign(machine, user)
      toast('ok', '已取消分配')
      await load()
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    }
  }

  return (
    <>
      <PageHeader title="分配" desc="把机器分配给用户，用户即可获取席位并打开控制台" />

      <Card title="新建分配">
        <div className="form-grid">
          <Field label="机器">
            <select className="select" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              {machines.length === 0 ? (
                <option value="">暂无机器</option>
              ) : (
                machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}（{shortId(m.id)}）
                  </option>
                ))
              )}
            </select>
          </Field>
          <Field label="用户">
            <select className="select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.length === 0 ? (
                <option value="">暂无用户</option>
              ) : (
                users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.id}
                  </option>
                ))
              )}
            </select>
          </Field>
          <Button variant="primary" disabled={busy} onClick={() => void assign()}>
            分配
          </Button>
        </div>
      </Card>

      <Card
        title="分配列表"
        actions={
          isPlatformAdmin ? (
            <select className="select" value={tenantFilter} onChange={(e) => setTenantFilter(e.target.value)}>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id}
                </option>
              ))}
            </select>
          ) : undefined
        }
      >
        {err ? <div className="login-error">{err}</div> : null}
        {assignments === null ? (
          <Spinner />
        ) : assignments.length === 0 ? (
          <Empty>暂无分配</Empty>
        ) : (
          <div className="card__body card__body--flush">
            <table className="table">
              <thead>
                <tr>
                  <th>机器</th>
                  <th>用户</th>
                  <th>分配时间</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={`${a.machineId}:${a.userId}`}>
                    <td>
                      <span style={{ fontWeight: 600 }}>{machineName(a.machineId)}</span>{' '}
                      <span className="mono muted">{shortId(a.machineId)}</span>
                    </td>
                    <td style={{ fontWeight: 600 }}>{a.userId}</td>
                    <td className="muted">{formatTime(a.createdAt)}</td>
                    <td className="cell-actions">
                      <Button variant="danger" onClick={() => void unassign(a.machineId, a.userId)}>
                        取消分配
                      </Button>
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
