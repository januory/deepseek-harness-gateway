import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { PublicUser, Tenant } from '../types'
import { Button, Card, Empty, Field, PageHeader, Spinner, formatTime, useToast } from '../ui'

export function TenantsView({ me }: { me: PublicUser }) {
  const toast = useToast()
  const [tenants, setTenants] = useState<Tenant[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api.tenants()
      setTenants(r.tenants)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function create() {
    if (!id.trim() || !name.trim()) {
      toast('error', '租户 ID 与名称必填')
      return
    }
    setBusy(true)
    try {
      await api.createTenant(id.trim(), name.trim())
      toast('ok', `已创建租户 ${id.trim()}`)
      setId('')
      setName('')
      await load()
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="租户" desc="平台级租户管理（仅平台管理员可见）" />

      <Card title="新建租户">
        <div className="form-grid">
          <Field label="租户 ID">
            <input className="input" placeholder="例如 acme" value={id} onChange={(e) => setId(e.target.value)} />
          </Field>
          <Field label="名称">
            <input className="input" placeholder="例如 Acme 公司" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={busy} onClick={() => void create()}>
            创建
          </Button>
        </div>
      </Card>

      {err ? <div className="login-error">{err}</div> : null}

      <Card title="租户列表">
        {tenants === null ? (
          <Spinner />
        ) : tenants.length === 0 ? (
          <Empty>暂无租户</Empty>
        ) : (
          <div className="card__body card__body--flush">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>名称</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{t.id}</td>
                    <td style={{ fontWeight: 600 }}>{t.name}</td>
                    <td className="muted">{formatTime(t.createdAt)}</td>
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
