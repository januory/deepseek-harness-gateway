# dsh-gateway-agent

English | [中文](README.zh.md)

The customer-machine access plugin for [deepseek-harness-gateway](../../README.md).

## What it is

`dsh-gateway-agent` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin installed in the dsh that runs on a customer machine. It opens a single **outbound** WebSocket to the gateway and bridges the machine's local dsh web UI over that same tunnel — so the machine needs **no inbound port, port mapping, or public IP**.

## Requirements

- A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation (web profile) on the machine.
- The gateway server (see `../../apps/gateway`) running and reachable from the machine, e.g. `wss://gateway.example.com/agent`.
- A pairing code issued by the gateway administrator.

## Install

```sh
dsh plugin --profile web add ./plugins/dsh-gateway-agent
```

(Once published, this becomes `dsh plugin --profile web add @januory/dsh-gateway-agent`.)

## Usage

1. Ask the gateway administrator for a pairing code.
2. Open the machine's dsh web UI and go to **Settings → 网关接入** (Gateway access).
3. Enter the gateway address (`wss://<gateway-host>/agent`) and the pairing code, then click **发起入网申请** (Request onboarding).
4. After the machine is approved at the gateway, the plugin reconnects automatically and keeps the tunnel alive — the machine is then operable from the gateway portal.

## Configuration

The plugin persists its configuration as JSON at `$DSH_HOME/dsh-gateway-agent/config.json`:

| Key          | Description                                                              |
| ------------ | ------------------------------------------------------------------------ |
| `gatewayUrl` | The gateway WebSocket endpoint, e.g. `wss://gateway.example.com/agent`. |
| `pairingCode`| The pairing code issued by the gateway administrator.                    |
| `dshPort`    | The local dsh web port to bridge (default `3080`).                       |

Values entered in the **网关接入** UI are saved here; the plugin auto-connects on boot when `gatewayUrl` is already set.

## How it works

The plugin runs as a dsh host plugin (Node) plus a small settings card in the browser client. On the host side it dials `gatewayUrl`, completes a pairing-code + HMAC challenge-response, then relays browser requests and WebSocket streams from the gateway to the machine's loopback dsh web (`127.0.0.1:<dshPort>`), injecting an operator cookie minted in-process via the dsh Connection service. Each relayed request is re-declared as one consistent same-origin loopback request: besides rewriting `Host`, the agent sets `Origin` (and any `Referer`) to `http://127.0.0.1:<dshPort>`, so third-party handlers that require `Origin === Host` — such as the plugin market's POST routes — work over the tunnel too.

See the [project README](../../README.md) for the full architecture.

## Daemon supervision (optional, off by default)

Tick **Settings → 网关接入 → 守护进程服务** and the machine's dsh lifecycle
(start / stop / restart) is owned by a standalone supervisor process, so the
gateway portal's machine catalog can control it remotely.

- The plugin itself lives inside dsh and therefore **cannot** restart it, so this
  step needs the supervisor running as its own service. Ready-made samples live
  in [`service/`](service/) (systemd / launchd / Windows scheduled task).
- The settings card shows the exact command that starts the supervisor on this
  machine, so you can service-ize it without guessing paths.
- The four commands shown and editable in the settings card (start / stop /
  restart / liveness probe) are the *entire* set of commands the gateway will
  run. **Stopping means stopped, and a crash stays visible**: a dsh that dies on
  its own is reported as `exited` and is *not* restarted automatically — click
  Start in the portal. (A supervisor restart, e.g. after a reboot, still brings
  dsh back up when the liveness probe says it is down.)
- Config lives in `$DSH_HOME/dsh-gateway-agent/daemon.json`; the supervisor's
  runtime state is written to `daemon-state.json` in the same directory and is
  what the settings card displays.

Leave it unticked if you do not need remote lifecycle control — nothing else
changes.