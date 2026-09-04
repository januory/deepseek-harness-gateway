import { useEffect, useState } from 'react'
import { api } from './api'
import type { MachineView, PublicUser } from './types'
import { RoleBadge, ToastProvider } from './ui'
import { LoginView } from './views/LoginView'
import { MachinesView } from './views/MachinesView'
import { UsersView } from './views/UsersView'
import { AssignmentsView } from './views/AssignmentsView'
import { PairingCodesView } from './views/PairingCodesView'
import { AuditView } from './views/AuditView'
import { SettingsView } from './views/SettingsView'
import { ConsoleView } from './views/ConsoleView'

type ViewKey = 'machines' | 'users' | 'assignments' | 'pairing' | 'audit' | 'settings'

interface NavItem {
  key: ViewKey
  label: string
  visible: (me: PublicUser) => boolean
}

const NAV: NavItem[] = [
  { key: 'machines', label: '机器目录', visible: () => true },
  { key: 'users', label: '用户', visible: (me) => me.role !== 'user' },
  { key: 'assignments', label: '分配', visible: (me) => me.role !== 'user' },
  { key: 'pairing', label: '配对码', visible: (me) => me.role !== 'user' },
  { key: 'audit', label: '审计', visible: (me) => me.role !== 'user' },
  { key: 'settings', label: '设置', visible: (me) => me.role !== 'user' },
]

function Shell({ me, onLogout }: { me: PublicUser; onLogout: () => void }) {
  const [view, setView] = useState<ViewKey>('machines')
  const [consoleMachine, setConsoleMachine] = useState<MachineView | null>(null)

  const items = NAV.filter((n) => n.visible(me))
  const active = items.some((n) => n.key === view) ? view : items[0].key

  function selectNav(key: ViewKey) {
    setConsoleMachine(null)
    setView(key)
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          dsh-gateway
          <small>受管网关路由器</small>
        </div>
        <nav>
          {items.map((n) => (
            <button
              key={n.key}
              className={`nav-item ${active === n.key && !consoleMachine ? 'nav-item--active' : ''}`}
              onClick={() => selectNav(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar__user">
          <div className="who">
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{me.id}</strong>
              <div>
                <RoleBadge role={me.role} />
              </div>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={onLogout} style={{ color: '#d1d5db' }}>
              退出
            </button>
          </div>
        </div>
      </aside>
      <main className={`main ${consoleMachine ? 'main--console' : ''}`}>
        {consoleMachine ? (
          <ConsoleView machine={consoleMachine} onBack={() => setConsoleMachine(null)} />
        ) : (
          <div className="main__inner">
            {active === 'machines' ? <MachinesView me={me} onOpenConsole={setConsoleMachine} /> : null}
            {active === 'users' ? <UsersView me={me} /> : null}
            {active === 'assignments' ? <AssignmentsView me={me} /> : null}
            {active === 'pairing' ? <PairingCodesView me={me} /> : null}
            {active === 'audit' ? <AuditView me={me} /> : null}
            {active === 'settings' ? <SettingsView me={me} /> : null}
          </div>
        )}
      </main>
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
    try {
      await api.logout()
    } catch {
      /* ignore */
    }
    setMe(null)
  }

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="spinner" />
      </div>
    )
  }

  if (!me) return <LoginView onLogin={setMe} />

  return (
    <ToastProvider>
      <Shell me={me} onLogout={() => void logout()} />
    </ToastProvider>
  )
}
