// Daemon-supervision wire vocabulary (shared by the gateway server, the
// dsh-gateway-agent plugin and the standalone supervisor process).
//
// A machine can hold TWO node connections to the gateway at the same time:
//   - `console`    — the plugin living inside the dsh process (data plane relay)
//   - `supervisor` — the standalone daemon that owns the dsh process lifecycle
// The supervisor keeps its socket open while dsh itself is stopped, which is
// what makes "stop" reversible from the portal.

/**
 * Node connection roles. The default is `console`, so an older plugin that
 * never sends a role keeps working exactly as before.
 */
export const NodeRole = Object.freeze({
  CONSOLE: 'console',
  SUPERVISOR: 'supervisor',
})

export const ConsoleRole = NodeRole.CONSOLE
export const SupervisorRole = NodeRole.SUPERVISOR

/**
 * Supervisor control messages (gateway ⇄ supervisor), carried on the
 * supervisor's node socket as JSON control frames.
 */
export const DaemonType = Object.freeze({
  /** gateway → supervisor: perform a lifecycle action. */
  DAEMON_CONTROL: 'daemon_control',
  /** supervisor → gateway: the outcome of a control request. */
  DAEMON_RESULT: 'daemon_result',
})

/** Lifecycle actions the portal can ask a supervised machine to perform. */
export const DaemonAction = Object.freeze({
  START: 'start',
  STOP: 'stop',
  RESTART: 'restart',
})

export const DAEMON_ACTIONS = Object.freeze([DaemonAction.START, DaemonAction.STOP, DaemonAction.RESTART])

/**
 * The supervisor's view of the managed dsh process, as reported to the gateway.
 *  - `unknown`  — supervisor just booted / config not readable yet
 *  - `starting` — an action is in flight
 *  - `running`  — dsh is up
 *  - `stopped`  — dsh was stopped on purpose (a `start` is still possible)
 *  - `exited`   — dsh died on its own (crash); needs an explicit `start`
 */
export const DaemonState = Object.freeze({
  UNKNOWN: 'unknown',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPED: 'stopped',
  EXITED: 'exited',
})

/**
 * How long the gateway waits for a supervisor to acknowledge a control request
 * before answering the portal with 503. The action itself may take longer (a
 * graceful stop waits for the child to exit); the ack only means "accepted and
 * the supervisor is still connected".
 */
export const DAEMON_CONTROL_TIMEOUT_MS = 12_000

export function isDaemonAction(value) {
  return DAEMON_ACTIONS.includes(value)
}

/** Normalize an untrusted role value; anything unknown degrades to `console`. */
export function normalizeRole(value) {
  return value === NodeRole.SUPERVISOR ? NodeRole.SUPERVISOR : NodeRole.CONSOLE
}

/** Normalize an untrusted daemon state; anything unknown degrades to `unknown`. */
export function normalizeDaemonState(value) {
  return typeof value === 'string' && Object.values(DaemonState).includes(value) ? value : DaemonState.UNKNOWN
}
