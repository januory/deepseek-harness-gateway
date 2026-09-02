// Wire protocol constants shared by the gateway server and dsh-gateway-agent.

/** Bump on any wire-incompatible change. */
export const PROTOCOL_VERSION = 1

/** Control-plane keepalive cadence (ms). */
export const HEARTBEAT_INTERVAL_MS = 15_000

/** Node lease lifetime (ms); a node is marked offline after this without heartbeats. */
export const LEASE_TTL_MS = 45_000

/** Outbound reconnect backoff bounds (ms). */
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 30_000

/** Control channel name for multiplexing. */
export const CONTROL_CHANNEL = 'control'

/** Data sub-channel name prefix: `<prefix><channelId>`. */
export const DATA_CHANNEL_PREFIX = 'data:'
