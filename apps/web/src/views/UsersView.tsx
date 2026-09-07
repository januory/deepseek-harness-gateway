import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { PublicUser, Role, UserView } from '../types'
import { Button, Card, Empty, Field, Modal, PageHeader, RoleBadge, Spinner, useToast } from '../ui'

export function UsersView({ me }: { me: PublicUser }) {
  const isSystemAdmin = me.role === 'system-admin'
  const toast = useToast()

  const [users, setUsers] = useState<UserView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // create form
  const [id, setId] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [creating, setCreating] = useState(false)

  // edit / delete
  const [edit, setEdit] = useState<{ u: UserView; role: Role; password: string } | null>(null)
  const [confirm, setConfirm] = useState<{ u: UserView } | null>(null)

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

  async function run(u: UserView, fn: () => Promise<unknown>) {
    setBusy(u.id)
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

  async function create() {
    if (!id.trim() || !password) {
      toast('error', '账号与密码必填')
      return
    }
    setCreating(true)
    try {
      await api.createUser(id.trim(), password, role)
      toast('ok', `已创建用户 ${id.trim()}`)
      setId('')
      setPassword('')
      setRole('user')
      await load()
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setCreating(false)
    }
  }

  function saveEdit() {
    if (!edit) return
    const { u, role, password } = edit
    if (role === u.role && !password) {
      toast('info', '没有需要保存的更改')
      return
    }
    setEdit(null)
    void run(u, () => api.updateUser(u.id, { role, ...(password ? { password } : {}) }))
  }

  function confirmDelete() {
    if (!confirm) return
    const { u } = confirm
    setConfirm(null)
    void run(u, () => api.deleteUser(u.id))
  }

  // A user may edit/delete a row unless it is their own account, or a
  // system-admin account they are not a system admin themselves.
  function canEdit(u: UserView): boolean {
    if (u.id === me.id) return false
    if (u.role === 'system-admin' && !isSystemAdmin) return false
    return true
  }
  const sysAdminCount = users?.filter((u) => u.role === 'system-admin').length ?? 0
  const lastSysAdmin = sysAdminCount <= 1

  return (
    <>
      <PageHeader title="用户" desc="管理用户与角色" />

      <Card title="新建用户">
        <div className="form-grid">
          <Field label="账号">
            <input
              className="input"
              placeholder="账号"
              name="newUserAccount"
              autoComplete="off"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </Field>
          <Field label="密码">
            <input
              className="input"
              type="password"
              placeholder="密码"
              name="newUserPassword"
              autoComplete="new-password"
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
          <Button variant="primary" disabled={creating} onClick={() => void create()}>
            创建
          </Button>
        </div>
      </Card>

      {err ? <div className="login-error">{err}</div> : null}

      <Card title="用户列表">
        <UsersTable
          users={users}
          me={me}
          busy={busy}
          canEdit={canEdit}
          disableDelete={(u) => u.role === 'system-admin' && lastSysAdmin}
          onEdit={(u) => setEdit({ u, role: u.role, password: '' })}
          onDelete={(u) => setConfirm({ u })}
        />
      </Card>

      <Modal
        open={edit !== null}
        title="编辑用户"
        confirmLabel="保存"
        onClose={() => setEdit(null)}
        onConfirm={saveEdit}
      >
        {edit ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="账号">
              <input className="input" value={edit.u.id} disabled />
            </Field>
            <Field label="角色">
              <select
                className="select"
                value={edit.role}
                onChange={(e) => setEdit({ ...edit, role: e.target.value as Role })}
              >
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
                {isSystemAdmin ? <option value="system-admin">系统管理员</option> : null}
              </select>
            </Field>
            <Field label="重置密码（留空则保持不变）">
              <input
                className="input"
                type="password"
                placeholder="新密码"
                autoComplete="new-password"
                value={edit.password}
                onChange={(e) => setEdit({ ...edit, password: e.target.value })}
              />
            </Field>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={confirm !== null}
        title="删除用户"
        confirmLabel="删除"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={confirmDelete}
      >
        {confirm ? (
          <p style={{ margin: 0 }}>
            确定删除用户 <strong>{confirm.u.id}</strong>？其机器分配将一并撤销，此操作不可撤销。
          </p>
        ) : null}
      </Modal>
    </>
  )
}

function UsersTable({
  users,
  me,
  busy,
  canEdit,
  disableDelete,
  onEdit,
  onDelete,
}: {
  users: UserView[] | null
  me: PublicUser
  busy: string | null
  canEdit: (u: UserView) => boolean
  disableDelete: (u: UserView) => boolean
  onEdit: (u: UserView) => void
  onDelete: (u: UserView) => void
}) {
  if (users === null) return <Spinner />
  if (users.length === 0) return <Empty>暂无用户</Empty>

  const actions = (u: UserView) =>
    canEdit(u) ? (
      <>
        <Button variant="default" disabled={busy === u.id} onClick={() => onEdit(u)}>
          编辑
        </Button>
        <Button
          variant="danger"
          disabled={busy === u.id || disableDelete(u)}
          title={disableDelete(u) ? '不能删除最后一个系统管理员' : undefined}
          onClick={() => onDelete(u)}
        >
          删除
        </Button>
      </>
    ) : null

  return (
    <>
      {/* Desktop: table */}
      <div className="users-table card__body card__body--flush">
        <table className="table">
          <thead>
            <tr>
              <th>账号</th>
              <th>角色</th>
              <th style={{ textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={{ fontWeight: 600 }}>
                  {u.id}
                  {u.id === me.id ? <span className="muted">（当前账号）</span> : null}
                </td>
                <td>
                  <RoleBadge role={u.role} />
                </td>
                <td className="cell-actions">{actions(u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: one stacked card per user (mirrors machines/assignments/audit) */}
      <div className="users-cards">
        {users.map((u) => (
          <div className="user-card" key={u.id}>
            <div className="user-card__head">
              <div className="user-card__title">
                <strong title={u.id}>{u.id}</strong>
                {u.id === me.id ? <span className="muted user-card__self">当前账号</span> : null}
              </div>
              <RoleBadge role={u.role} />
            </div>
            <div className="user-card__actions">{actions(u)}</div>
          </div>
        ))}
      </div>
    </>
  )
}
