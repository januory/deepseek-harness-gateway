import { useEffect, useState } from 'react'

interface Health {
  ok: boolean
  service?: string
  version?: string
  protocol?: number
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(String(e)))
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>deepseek-harness-gateway</h1>
      <p>门户占位页 — 登录 / 机器目录 / 管理审批 / 审计将在 P1 接入。</p>
      <section>
        <h2>后端状态</h2>
        {error ? <p style={{ color: 'crimson' }}>无法连接网关：{error}</p> : null}
        {health ? (
          <pre>{JSON.stringify(health, null, 2)}</pre>
        ) : error ? null : (
          <p>加载中…</p>
        )}
      </section>
    </div>
  )
}
