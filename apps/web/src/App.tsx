import { useEffect, useState } from 'react'
import { api, type MachineView, type PublicUser } from './api'

const styles: Record<string, React.CSSProperties> = {
  page: { fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 960, margin: '0 auto' },
  error: { color: 'crimson' },
  box: { border: '1px solid #e0e0e0', borderRadius: 8, padding: 16, marginBottom: 16 },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #f0f0f0' },
  btn: { padding: '6px 12px', cursor: 'pointer', borderRadius: 6, border: '1px solid #ccc', background: '#fff' },
  primary: { padding: '6px 12px', cursor: 'pointer', borderRadius: 6, border: '1px solid #2563eb', background: '#2563eb', color: '#fff' },
  input: { padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', flex: 1 },
  muted: { color: '#666', fontSize: 13 },
  code: { fontFamily: 'monospace', background: '#f5f5f5', padding: '2px 6px', borderRadius: 4 },
}

function Login({ onLogin }: { onLogin: (u: PublicUser) => void }) {
  const [id, setId] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      const { user } = await api.login(id, password)
      onLogin(user)
    } catch (e2) {
      setErr(String((e2 as Error).message ?? e2))
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto' }}>
      <h1>deepseek-harness-gateway</h1>
      <form onSubmit={submit} style={styles.box}>
        <h2 style={{ marginTop: 0 }}>登录</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input style={styles.input} placeholder="账号" value={id} onChange={(e) => setId(e.target.value)} />
          <input style={styles.input} type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
          {err ? <div style={styles.error}>{err}</div> : null}
          <button type="submit" style={styles.primary}>登录</button>
        </div>
      </form>
    </div>
  )
}

function MachineRow({ m, me, onChanged }: { m: MachineView; me: PublicUser; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const isAdmin = me.role !== 'user'
  const mySeat = m.seat?.userId === me.id

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
      onChanged()
    } catch (e) {
      window.alert(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  function openConsole() {
    void run(async () => {
      await api.acquireSeat(m.id)
      window.location.assign('/console/' + m.id + '/')
    })
  }

  return (
    <div style={styles.row}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: m.online ? '#22c55e' : '#d1d5db', display: 'inline-block' }} />
      <div style={{ flex: 1 }}>
        <div>
          <strong>{m.name}</strong> <span style={styles.code}>{m.id.slice(0, 8)}</span>
        </div>
        <div style={styles.muted}>
          {m.status} · {m.dshVersion || '—'} · 席位 {m.seat ? `由 ${m.seat.userId} 持有` : '空闲'}
        </div>
      </div>
      {m.status === 'approved' && (
        <>
          {mySeat ? (
            <button style={styles.btn} disabled={busy} onClick={() => run(() => api.releaseSeat(m.id))}>释放席位</button>
          ) : (
            <button style={styles.btn} disabled={busy} onClick={() => run(() => api.acquireSeat(m.id))}>获取席位</button>
          )}
          <button style={styles.primary} disabled={busy} onClick={openConsole}>打开控制台</button>
        </>
      )}
      {isAdmin && m.status === 'pending' && (
        <button style={styles.primary} disabled={busy} onClick={() => run(() => api.approve(m.id))}>批准</button>
      )}
      {isAdmin && m.status === 'approved' && (
        <button style={styles.btn} disabled={busy} onClick={() => run(() => api.revoke(m.id))}>吊销</button>
      )}
      {isAdmin && (
        <button
          style={{ ...styles.btn, color: '#dc2626', borderColor: '#dc2626' }}
          disabled={busy}
          onClick={() => {
            if (window.confirm(`删除机器 ${m.name}（${m.id.slice(0, 8)}）？此操作不可撤销。`)) {
              void run(() => api.deleteMachine(m.id))
            }
          }}
        >
          删除
        </button>
      )}
    </div>
  )
}

function AdminPanel({ onChanged }: { me: PublicUser; onChanged: () => void }) {
  const [userId, setUserId] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [assignUser, setAssignUser] = useState('')
  const [assignMachine, setAssignMachine] = useState('')
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null)
  const [audit, setAudit] = useState<Array<Record<string, unknown>>>([])

  async function issueCode() {
    const r = await api.issuePairingCode()
    setPairing({ code: r.code, expiresAt: r.expiresAt })
  }

  async function createUser() {
    if (!userId || !userPassword) return window.alert('填写账号与密码')
    await api.createUser(userId, userPassword, 'user')
    window.alert('已创建用户 ' + userId)
    setUserId('')
    setUserPassword('')
  }

  async function doAssign() {
    if (!assignMachine || !assignUser) return window.alert('填写机器与用户')
    await api.assign(assignMachine, assignUser)
    window.alert('已分配')
    onChanged()
  }

  async function loadAudit() {
    const r = await api.audit()
    setAudit(r.events)
  }

  return (
    <div style={styles.box}>
      <h2>管理</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={styles.btn} onClick={() => void issueCode()}>签发配对码</button>
        {pairing ? (
          <span style={styles.muted}>
            配对码 <span style={styles.code}>{pairing.code}</span>（{new Date(pairing.expiresAt).toLocaleString()} 前有效）
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input style={styles.input} placeholder="新用户账号" value={userId} onChange={(e) => setUserId(e.target.value)} />
        <input style={styles.input} placeholder="密码" value={userPassword} onChange={(e) => setUserPassword(e.target.value)} />
        <button style={styles.btn} onClick={() => void createUser()}>创建用户</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input style={styles.input} placeholder="机器 ID" value={assignMachine} onChange={(e) => setAssignMachine(e.target.value)} />
        <input style={styles.input} placeholder="用户 ID" value={assignUser} onChange={(e) => setAssignUser(e.target.value)} />
        <button style={styles.btn} onClick={() => void doAssign()}>分配机器</button>
      </div>
      <div style={{ marginTop: 12 }}>
        <button style={styles.btn} onClick={() => void loadAudit()}>加载审计</button>
        {audit.length > 0 ? (
          <pre style={{ fontSize: 12, maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(audit, null, 2)}</pre>
        ) : null}
      </div>
    </div>
  )
}

function Dashboard({ me, onLogout }: { me: PublicUser; onLogout: () => void }) {
  const [machines, setMachines] = useState<MachineView[]>([])
  const [err, setErr] = useState<string | null>(null)
  const isAdmin = me.role !== 'user'

  async function load() {
    setErr(null)
    try {
      const r = await api.machines()
      setMachines(r.machines)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div style={styles.page}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1>deepseek-harness-gateway</h1>
        <div>
          <span style={styles.muted}>{me.id}（{me.role}）</span>{' '}
          <button style={styles.btn} onClick={onLogout}>退出</button>
        </div>
      </div>

      <div style={styles.box}>
        <h2 style={{ marginTop: 0 }}>机器目录</h2>
        {err ? <div style={styles.error}>{err}</div> : null}
        {machines.length === 0 ? <div style={styles.muted}>暂无机器</div> : machines.map((m) => <MachineRow key={m.id} m={m} me={me} onChanged={() => void load()} />)}
      </div>

      {isAdmin ? <AdminPanel me={me} onChanged={() => void load()} /> : null}
    </div>
  )
}

export function App() {
  const [me, setMe] = useState<PublicUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false))
  }, [])

  async function logout() {
    await api.logout()
    setMe(null)
  }

  if (loading) return <div style={styles.page}>加载中…</div>
  if (!me) return <Login onLogin={setMe} />
  return <Dashboard me={me} onLogout={() => void logout()} />
}
