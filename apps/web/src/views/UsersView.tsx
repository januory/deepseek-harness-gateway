import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { PublicUser, Role, UserView } from '../types'
import { Button, Card, Empty, Field, PageHeader, RoleBadge, Spinner, useToast } from '../ui'

export function UsersView({ me }: { me: PublicUser }) {
  const isSystemAdmin = me.role === 'system-admin'
  const toast = useToast()

  const [users, setUsers] = useState<UserView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // create form
  const [id, setId] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api.users()
      setUsers(r.users)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function create() {
    if (!id.trim() || !password) {
      toast('error', '账号与密码必填')
      return
    }
    setBusy(true)
    try {
      await api.createUser(id.trim(), password, role)
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
              <option value="admin">管理员</option>
              {isSystemAdmin ? <option value="system-admin">系统管理员</option> : null}
            </select>
          </Field>
          <Button variant="primary" disabled={busy} onClick={() => void create()}>
            创建
          </Button>
        </div>
      </Card>

      {err ? <div className="login-error">{err}</div> : null}

      <Card title="用户列表">
        <UsersTable users={users} />
      </Card>
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
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={{ fontWeight: 600 }}>{u.id}</td>
              <td>
                <RoleBadge role={u.role} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
