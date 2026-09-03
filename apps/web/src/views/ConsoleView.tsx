import type { MachineView } from '../types'
import { Button, StatusDot, shortId } from '../ui'

// In-portal machine console: a same-origin iframe pointing at the relayed dsh
// web UI (/console/:machineId/). The upstream dsh web sends no X-Frame-Options
// and uses a relative Vite base, so it frames correctly under this path.
export function ConsoleView({ machine, onBack }: { machine: MachineView; onBack: () => void }) {
  return (
    <div className="console">
      <div className="console__bar">
        <div className="console__title">
          <StatusDot online={machine.online} />
          <strong>{machine.name}</strong>
          <span className="mono muted" title={machine.id}>
            {shortId(machine.id)}
          </span>
        </div>
        <div className="console__actions">
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
      <iframe
        className="console__frame"
        src={'/console/' + machine.id + '/'}
        title={machine.name}
        allow="fullscreen"
      />
    </div>
  )
}
