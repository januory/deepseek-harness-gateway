# deepseek-harness-gateway

[English](README.md) | 中文

面向公网部署的**网关路由器**：把分布在各客户机上的 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 实例，统一接入一条受管反向隧道。管理员审批机器入网并分配给普通用户，用户在网关 Web 门户上完整操控被分配机器的 dsh WebUI——客户机**零公网暴露**。

## 它做了什么

每台客户机在自己的 dsh 里装一个轻量插件（`dsh-gateway-agent`），插件向网关发起唯一一条**出站** WebSocket 连接，因此客户机不需要任何入站端口、端口映射或公网 IP。机器入网并被分配后，网关把浏览器的请求经同一条隧道中继到该机器的 dsh WebUI——客户机始终不直接暴露在公网上。

## 功能特性

- **网关** —— 唯一公网入口；机器注册审批、用户分配、席位、审计都收口在网关。
- **只出站的反向隧道** —— 客户机 dsh 通过 `wss` 出站连接；零入站监听。
- **管理员审批** —— 机器凭配对码 + HMAC 挑战应答入网，由管理员审批。
- **身份与授权都在网关** —— 机器身份由网关签发，所有授权都在网关侧执行，而非客户机。
- **零改动的数据面** —— 网关原样中继官方 dsh web UI（HTTP + WebSocket），无需 fork dsh。
- **门户完整操控** —— 操作员在网关门户里直接操控被分配机器的 dsh WebUI。

## 工作原理

```
公网网关（唯一暴露面）      客户机（零入站）

┌──────────────────────────────────────┐                   ┌──────────────────────────────────────┐
│Web portal / control plane / router   │                   │dsh-gateway-agent plugin              │
│register · assign · audit   │◄── wss outbound ──│(installed in customer dsh)           │
│                                      │                   │↓ loopback                            │
│                                      │                   │dsh web :3080                         │
└──────────────────────────────────────┘                   └──────────────────────────────────────┘
```

- **`apps/gateway`** —— 网关服务器：控制面、路由器、HTTP API 与 WebSocket 升级处理；同时托管构建好的门户。
- **`apps/web`** —— 门户前端（Vite + React）。
- **`plugins/dsh-gateway-agent`** —— 装进客户机 dsh 的插件：出站连接 `/agent`，桥接本机 dsh web。
- **`packages/protocol`** / **`packages/store`** —— 共享 wire 协议与持久化接缝。

插件拨号 `wss://<网关主机>/agent`，完成配对码 + HMAC 握手；审批通过后网关以心跳/租约保持节点在线，并把浏览器请求（`/console/:machineId/*`）中继到该机器的 loopback dsh web（`127.0.0.1:3080`）。

## 环境要求

- Node.js ≥ 20（网关各包运行于 Node 22+）。
- [pnpm](https://pnpm.io) —— 本仓库是 pnpm workspace。
- 每台客户机需有 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（web profile），用于承载接入插件。

## 安装

克隆并安装依赖：

```sh
git clone <本仓库地址>
cd deepseek-harness-gateway
pnpm install
```

启动网关：

```sh
pnpm --filter dsh-gateway-server dev      # http://127.0.0.1:3300/health
```

开发模式启动门户前端（把 `/health` 与 `/agent` 代理到 3300 的网关）：

```sh
pnpm --filter dsh-gateway-web dev
```

构建门户，交给网关在根路径静态托管：

```sh
pnpm --filter dsh-gateway-web build
```

把接入插件装进客户机的 dsh（web profile）：

```sh
dsh plugin --profile web add ./plugins/dsh-gateway-agent
```

## 使用

1. 启动网关（`pnpm --filter dsh-gateway-server dev`），并可按需构建门户（`pnpm --filter dsh-gateway-web build`），使其由网关根路径托管。
2. 签发配对码：
   ```sh
   GATEWAY_PAIRING_CODES="<code>" pnpm --filter dsh-gateway-server dev
   ```
3. 在客户机上装好接入插件（见"安装"），打开 dsh 的 **设置 → 网关接入**，填入网关地址（`wss://<网关主机>`，不含路径）与配对码，点 **发起入网申请**。
4. 在网关侧审批该机器、分配给用户，然后从门户打开——读取与交互会实时中继到该机器的 dsh WebUI。

## 目录结构

```
apps/gateway/                 # 网关服务器（控制面+路由器+API+wss，托管门户产物）
apps/web/                     # 门户前端（Vite + React）
packages/protocol/            # 共享 wire 协议（纯 JS，零构建）
packages/store/               # 持久化接缝（IStore）+ 领域类型
plugins/dsh-gateway-agent/    # 客户机接入插件（出站 wss 桥接本机 dsh web）
```
