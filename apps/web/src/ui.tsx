// Small, dependency-free UI primitives shared across portal views.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { MachineStatus, Role } from './types'

// ---- buttons ----------------------------------------------------------------

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

export function Button({
  variant = 'default',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button className={`btn btn--${variant} ${className}`} {...rest} />
}

// ---- badges / dots ------------------------------------------------------------

export function StatusDot({ online }: { online: boolean }) {
  return <span className={`dot ${online ? 'dot--on' : 'dot--off'}`} title={online ? '在线' : '离线'} />
}

export function RoleBadge({ role }: { role: Role }) {
  const cls = role === 'system-admin' ? 'badge--purple' : role === 'admin' ? 'badge--blue' : 'badge--gray'
  const label = role === 'system-admin' ? '系统管理员' : role === 'admin' ? '管理员' : '普通用户'
  return <span className={`badge ${cls}`}>{label}</span>
}

export function StatusBadge({ status }: { status: MachineStatus }) {
  const cls = status === 'approved' ? 'badge--green' : status === 'pending' ? 'badge--amber' : 'badge--red'
  const label = status === 'approved' ? '已批准' : status === 'pending' ? '待批准' : '已吊销'
  return <span className={`badge ${cls}`}>{label}</span>
}

export function ResultBadge({ result }: { result: 'ok' | 'denied' | 'error' }) {
  const cls = result === 'ok' ? 'badge--green' : result === 'denied' ? 'badge--amber' : 'badge--red'
  return <span className={`badge ${cls}`}>{result}</span>
}

// ---- layout pieces ------------------------------------------------------------

export function PageHeader({ title, desc, actions }: { title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {desc ? <p className="muted">{desc}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </div>
  )
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {title || actions ? (
        <div className="card__head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="card__actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  )
}

export function Empty({ children }: { children?: ReactNode }) {
  return <div className="empty">{children ?? '暂无数据'}</div>
}

export function Spinner() {
  return <div className="spinner" aria-label="加载中" />
}

export function formatTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

// ---- modal --------------------------------------------------------------------

export function Modal({
  open,
  title,
  children,
  confirmLabel = '确认',
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">{title}</h3>
        <div className="modal__body">{children}</div>
        <div className="modal__foot">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---- toast ----------------------------------------------------------------------

type ToastKind = 'info' | 'ok' | 'error'
interface Toast {
  id: number
  kind: ToastKind
  text: string
}

const ToastContext = createContext<(kind: ToastKind, text: string) => void>(() => {})

let nextToastId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  function push(kind: ToastKind, text: string) {
    const id = nextToastId++
    setToasts((ts) => [...ts, { id, kind, text }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4000)
  }

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
