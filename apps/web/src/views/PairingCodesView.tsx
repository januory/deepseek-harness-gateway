import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { PairingCodeView, PublicUser } from '../types'
import { Button, Card, Empty, Field, PageHeader, Spinner, formatTime, shortId, useToast } from '../ui'

export function PairingCodesView({ me }: { me: PublicUser }) {
  const toast = useToast()

  const [codes, setCodes] = useState<PairingCodeView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [ttlMin, setTtlMin] = useState(10)
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api.pairingCodes()
      setCodes(r.codes)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function issue() {
    setBusy(true)
    setIssued(null)
    try {
      const r = await api.issuePairingCode(ttlMin * 60_000)
      setIssued({ code: r.code, expiresAt: r.expiresAt })
      toast('ok', '已签发配对码')
      await load()
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function copyCode() {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.code)
      toast('ok', '已复制到剪贴板')
    } catch {
      toast('error', '复制失败，请手动选择复制')
    }
  }

  return (
    <>
      <PageHeader title="配对码" desc="签发一次性配对码，节点用它完成首次入网" />

      <Card title="签发配对码">
        <div className="form-grid">
          <Field label="有效期（分钟）">
            <input
              className="input"
              type="number"
              min={1}
              value={ttlMin}
              onChange={(e) => setTtlMin(Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
          <Button variant="primary" disabled={busy} onClick={() => void issue()}>
            签发
          </Button>
        </div>
        {issued ? (
          <div style={{ marginTop: 14 }}>
            <div className="pairing-reveal">
              <code>{issued.code}</code>
              <Button variant="primary" onClick={() => void copyCode()}>
                复制
              </Button>
            </div>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              一次性使用，{formatTime(issued.expiresAt)} 前有效，请立即交给节点。
            </p>
          </div>
        ) : null}
      </Card>

      <Card title="配对码列表">
        {err ? <div className="login-error">{err}</div> : null}
        {codes === null ? (
          <Spinner />
        ) : codes.length === 0 ? (
          <Empty>暂无配对码</Empty>
        ) : (
          <div className="card__body card__body--flush">
            <table className="table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>使用机器</th>
                  <th>过期时间</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((c, i) => (
                  <tr key={`${c.expiresAt}:${i}`}>
                    <td>{c.consumedBy ? <span className="badge badge--gray">已使用</span> : <span className="badge badge--green">未使用</span>}</td>
                    <td className="mono muted">{c.consumedBy ? shortId(c.consumedBy) : '—'}</td>
                    <td className="muted">{formatTime(c.expiresAt)}</td>
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
