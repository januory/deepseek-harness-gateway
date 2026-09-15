// In-flight daemon-control requests (gateway → supervisor).
//
// The portal's POST /gw/machines/:id/daemon/:action is request/response over the
// supervisor's node socket, but the socket is a live WebSocket that can drop at
// any moment. This map keeps the correlation id → resolver pairs and makes sure
// every request settles exactly once — on result, on timeout, or when the
// supervisor disconnects. Extracted from NodeRegistry so the settle-once
// behaviour is unit-testable without booting a gateway.

export interface DaemonControlResult {
  ok: boolean
  state?: string
  error?: string
}

export interface PendingControl {
  action: string
  resolve(result: DaemonControlResult): void
  timer?: ReturnType<typeof setTimeout>
}

export type DaemonControlRequestId = string

export interface DaemonControlRegistryOptions {
  /** How long to wait for a supervisor result before failing the request. */
  timeoutMs: number
  /** Diagnostic hook for timeouts (e.g. gateway log line). */
  onTimeout?(id: string, action: string): void
  /** Timer primitives, injectable for tests. */
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export class DaemonControlRegistry {
  private pending = new Map<DaemonControlRequestId, PendingControl>()
  private seq = 0

  constructor(private readonly opts: DaemonControlRegistryOptions) {}

  get size(): number {
    return this.pending.size
  }

  /**
   * Register a request. The returned `id` is what the gateway puts on the wire;
   * `promise` rejects with a user-facing message if the supervisor never
   * answers (offline, wedged, or mid-restart).
   */
  register(action: string): { id: DaemonControlRequestId; promise: Promise<DaemonControlResult> } {
    const id = `d${++this.seq}-${Date.now().toString(36)}`
    const setTimer = this.opts.setTimer ?? setTimeout
    const promise = new Promise<DaemonControlResult>((resolve, reject) => {
      const entry: PendingControl = { action, resolve }
      entry.timer = setTimer(() => {
        this.pending.delete(id)
        this.opts.onTimeout?.(id, action)
        reject(new Error(`daemon ${action} timed out (supervisor did not answer)`))
      }, this.opts.timeoutMs)
      this.pending.set(id, entry)
    })
    return { id, promise }
  }

  /** Settle one request from a `daemon_result` frame. Unknown ids are ignored. */
  settle(id: DaemonControlRequestId, result: DaemonControlResult): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    if (entry.timer) (this.opts.clearTimer ?? clearTimeout)(entry.timer)
    entry.resolve(result)
    return true
  }

  /** Fail every in-flight request (called when the supervisor socket closes). */
  failAll(reason: string): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.timer) (this.opts.clearTimer ?? clearTimeout)(entry.timer)
      entry.resolve({ ok: false, error: reason })
    }
  }
}
