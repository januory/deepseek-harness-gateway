# deepseek-harness-gateway

English | [中文](README.zh.md)

A public-deployment **gateway router** that brings distributed [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) instances on customer machines behind one managed reverse tunnel. Administrators approve machine onboarding and assign machines to users, who then fully operate the assigned machine's dsh WebUI from the gateway's web portal — with **zero public exposure** on the customer side.

## What it does

Each customer machine runs a small plugin (`dsh-gateway-agent`) inside its own dsh. The plugin dials a single **outbound** WebSocket connection to the gateway, so the customer machine needs no inbound port, port mapping, or public IP. Once a machine is onboarded and assigned, the gateway relays browser requests to that machine's dsh WebUI over the same tunnel — the customer machine is never exposed to the internet.

## Features

- **Gateway** — one public entry point; machine registration/approval, user assignment, seats, and audit all live at the gateway.
- **Outbound-only reverse tunnel** — customer dsh connects out over `wss`; zero inbound listeners.
- **Admin approval** — machines join via a pairing code + HMAC challenge-response, approved by an administrator.
- **Gateway-held identity & authorization** — machine identity is issued by the gateway, and all authorization is enforced at the gateway rather than on the customer machine.
- **Zero-change data plane** — the gateway relays the official dsh web UI (HTTP + WebSocket) untouched; no fork of dsh is required.
- **Full control from the portal** — operators drive the assigned machine's dsh WebUI from the gateway portal.

## How it works

```
Public gateway (only exposed surface)      Customer machine (zero inbound)

┌──────────────────────────────────────┐                   ┌──────────────────────────────────────┐
│Web portal / control plane / router   │                   │dsh-gateway-agent plugin              │
│register · assign · audit   │◄── wss outbound ──│(installed in customer dsh)           │
│                                      │                   │↓ loopback                            │
│                                      │                   │dsh web :3080                         │
└──────────────────────────────────────┘                   └──────────────────────────────────────┘
```

- **`apps/gateway`** — the gateway server: control plane, router, HTTP API, and WebSocket upgrade handling; it also hosts the built portal.
- **`apps/web`** — the portal front end (Vite + React).
- **`plugins/dsh-gateway-agent`** — the plugin installed in a customer's dsh; it dials out to `/agent` and bridges the machine's local dsh web.
- **`packages/protocol`** / **`packages/store`** — shared wire protocol and the persistence seam.

The agent dials `wss://<gateway-host>/agent` and completes a pairing-code + HMAC handshake. After approval the gateway keeps the node leased via heartbeat and relays browser requests (`/console/:machineId/*`) to the machine's loopback dsh web (`127.0.0.1:3080`).

## Requirements

- Node.js ≥ 20 (the gateway packages run on Node 22+).
- [pnpm](https://pnpm.io) — this repository is a pnpm workspace.
- A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation (web profile) on each customer machine, to host the agent plugin.

## Installation

Clone and install dependencies:

```sh
git clone <this-repo-url>
cd deepseek-harness-gateway
pnpm install
```

Run the gateway server:

```sh
pnpm --filter dsh-gateway-server dev      # http://127.0.0.1:3300/health
```

Run the portal front end in development (proxies `/health` and `/agent` to the gateway on 3300):

```sh
pnpm --filter dsh-gateway-web dev
```

Build the portal so the gateway serves it statically at the root:

```sh
pnpm --filter dsh-gateway-web build
```

Install the agent plugin into a customer machine's dsh (web profile):

```sh
dsh plugin --profile web add ./plugins/dsh-gateway-agent
```

## Usage

1. Start the gateway (`pnpm --filter dsh-gateway-server dev`) and, optionally, build the portal (`pnpm --filter dsh-gateway-web build`) so it is served at the gateway root.
2. Issue a pairing code to onboard:
   ```sh
   GATEWAY_PAIRING_CODES="<code>" pnpm --filter dsh-gateway-server dev
   ```
3. On the customer machine, install the agent plugin (see Installation), then open the dsh **Settings → 网关接入** section, enter the gateway address (`wss://<gateway-host>`, path not required) and the pairing code, and click **发起入网申请**.
4. Approve the machine at the gateway, assign it to a user, and open it from the portal — reads and interactions are relayed to that machine's dsh WebUI in real time.

## Repository structure

```
apps/gateway/                 # gateway server (control plane + router + API + wss; hosts the portal build)
apps/web/                     # portal front end (Vite + React)
packages/protocol/            # shared wire protocol (plain JS, zero build)
packages/store/               # persistence seam (IStore) + domain types
plugins/dsh-gateway-agent/    # customer-machine access plugin (outbound wss bridge to local dsh web)
```
