// Control-plane message type names (stringly typed so plain-JS consumers can't drift).

export const ControlType = Object.freeze({
  HELLO: 'hello',
  CHALLENGE: 'challenge',
  CHALLENGE_RESPONSE: 'challenge_response',
  PAIR_REQUEST: 'pair_request',
  REGISTER: 'register',
  REGISTRATION_STATUS: 'registration_status',
  HEARTBEAT: 'heartbeat',
  LEASE: 'lease',
  REVOKE: 'revoke',
  CONFIG_UPDATE: 'config_update',
  ERROR: 'error',
})

/** Binary data-frame kinds (ws relay needs to preserve text vs binary). */
export const DataKind = Object.freeze({
  BINARY: 1,
  TEXT: 2,
})

/** Data-plane (relay) control message type names carried on the node channel. */
export const DataType = Object.freeze({
  RELAY_REQUEST: 'relay_request',
  RELAY_RESPONSE: 'relay_response',
  RELAY_END: 'relay_end',
  RELAY_WS_OPEN: 'relay_ws_open',
  RELAY_WS_OPEN_OK: 'relay_ws_open_ok',
  RELAY_WS_CLOSE: 'relay_ws_close',
})
