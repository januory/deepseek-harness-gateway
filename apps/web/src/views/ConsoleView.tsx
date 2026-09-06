import { useEffect, useState } from 'react'
import type { MachineView } from '../types'
import { Button, StatusDot, shortId } from '../ui'

// In-portal machine console: a same-origin iframe pointing at the relayed dsh
// web UI (/console/:machineId/). The upstream dsh web sends no X-Frame-Options
// and uses a relative Vite base, so it frames correctly under this path.
export function ConsoleView({ machine, onBack }: { machine: MachineView; onBack: () => void }) {
  const [collapsed, setCollapsed] = useState(false)

  // Open collapsed by default: render the status bar expanded for one frame,
  // then collapse so its collapse animation plays on entry (the console takes
  // the full frame; the floating expand pill restores the bar).
  useEffect(() => {
    let raf = 0
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => setCollapsed(true))
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  const toggle = () => setCollapsed((c) => !c)

  return (
    <div className="console">
      <div className={`console__bar ${collapsed ? 'console__bar--collapsed' : ''}`}>
        <div className="console__bar-row">
          <div className="console__title">
            <StatusDot online={machine.online} />
            <strong>{machine.name}</strong>
            <span className="mono muted" title={machine.id}>
              {shortId(machine.id)}
            </span>
          </div>
          <div className="console__actions">
            <Button variant="ghost" onClick={toggle} aria-label="收起状态栏" title="收起状态栏">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 15 12 9 18 15" />
              </svg>
              收起
            </Button>
            <Button
              variant="ghost"
              onClick={() => window.open('/console/' + machine.id + '/', '_blank', 'noopener,noreferrer')}
            >
              新窗口打开
            </Button>
            <Button variant="ghost" onClick={onBack}>
              退出控制台
            </Button>
          </div>
        </div>
      </div>

      {collapsed ? (
        <button className="console__expander" type="button" onClick={toggle} aria-label="展开状态栏" title="展开状态栏">
          <span className="console__expander-name">{machine.name}</span>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      ) : null}

      <iframe
        className="console__frame"
        src={'/console/' + machine.id + '/'}
        title={machine.name}
        allow="fullscreen"
      />
    </div>
  )
}
