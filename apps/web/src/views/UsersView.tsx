import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { PublicUser, Role, Tenant, UserView } from '../types'
import { Button, Card, Empty, Field, PageHeader, RoleBadge, Spinner, useToast } from '../ui'

export function UsersView({ me }: { me: PublicUser }) {
  const isPlatformAdmin = me.role === 'platform-admin'
  const toast = useToast()

  const [users, setUsers] = useState<UserView[] | null>(null)
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [tenantFilter, setTenantFilter] = useState(me.tenantId)
  const [err, setErr] = useState<string | null>(null)

  // create form
  const [id, setId] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [tenantId, setTenantId] = useState(me.tenantId)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api.users(isPlatformAdmin ? tenantFilter : undefined)
      setUsers(r.users)
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

  async function create() {
    if (!id.trim() || !password) {
      toast('error', '账号与密码必填')
      return
    }
    setBusy(true)
    try {
      await api.createUser(id.trim(), password, role, isPlatformAdmin ? tenantId : undefined)
      toast('ok', `已创建用户 ${id.trim()}`)
      setId('')
      setPassword('')
      await load()
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="用户" desc="管理用户与角色" />

      <Card title="新建用户">
        <div className="form-grid">
          <Field label="账号">
            <input className="input" placeholder="账号" value={id} onChange={(e) => setId(e.target.value)} />
          </Field>
          <Field label="密码">
            <input
              className="input"
              type="password"
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="角色">
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="user">普通用户</option>
              <option value="tenant-admin">租户管理员</option>
              {isPlatformAdmin ? <option value="platform-admin">平台管理员</option> : null}
            </select>
          </Field>
          {isPlatformAdmin ? (
            <Field label="租户">
              <select className="select" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Button variant="primary" disabled={busy} onClick={() => void create()}>
            创建
          </Button>
        </div>
      </Card>

      {isPlatformAdmin ? (
        <Card title="用户列表">
          <div className="card__body" style={{ paddingTop: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 320 }}>
              <span className="field__label">按租户筛选</span>
              <select className="select" style={{ flex: 1 }} value={tenantFilter} onChange={(e) => setTenantFilter(e.target.value)}>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <UsersTable users={users} />
        </Card>
      ) : (
        <Card title="用户列表">
          <UsersTable users={users} />
        </Card>
      )}

      {err ? <div className="login-error">{err}</div> : null}
    </>
  )
}

function UsersTable({ users }: { users: UserView[] | null }) {
  if (users === null) return <Spinner />
  if (users.length === 0) return <Empty>暂无用户</Empty>
  return (
    <div className="card__body card__body--flush">
      <table className="table">
        <thead>
          <tr>
            <th>账号</th>
            <th>角色</th>
            <th>租户</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={{ fontWeight: 600 }}>{u.id}</td>
              <td>
                <RoleBadge role={u.role} />
              </td>
              <td className="mono muted">{u.tenantId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
