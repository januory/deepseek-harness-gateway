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
  const [navOpen, setNavOpen] = useState(false)

  const items = NAV.filter((n) => n.visible(me))
  const active = items.some((n) => n.key === view) ? view : items[0].key

  function selectNav(key: ViewKey) {
    setConsoleMachine(null)
    setView(key)
    setNavOpen(false)
  }

  return (
    <div className="shell">
      {navOpen ? <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} /> : null}
      <aside className={`sidebar ${navOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          DSH-Gateway
          <small>Deepseek-Harness 网关</small>
          <a
            className="sidebar__github"
            href="https://github.com/januory/deepseek-harness-gateway"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            GitHub
          </a>
        </div>
        <button className="sidebar__close" aria-label="关闭菜单" onClick={() => setNavOpen(false)}>
          ✕
        </button>
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
            <RoleBadge role={me.role} />
            <div className="who__row">
              <strong className="who__name">{me.id}</strong>
              <button className="who__logout" onClick={onLogout} aria-label="退出登录" title="退出登录">
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                退出
              </button>
            </div>
          </div>
        </div>
      </aside>
      <main className={`main ${consoleMachine ? 'main--console' : ''}`}>
        {!consoleMachine ? (
          <button className="hamburger" aria-label="打开菜单" onClick={() => setNavOpen(true)}>
            ☰
          </button>
        ) : null}
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
