# dsh-gateway-agent

[English](README.md) | 中文

[deepseek-harness-gateway](../README.md) 的客户机接入插件。

## 它是什么

`dsh-gateway-agent` 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，装进客户机上运行的 dsh 里。它向网关发起唯一一条**出站** WebSocket，并把本机 dsh web UI 经同一条隧道桥接出去——因此客户机**无需任何入站端口、端口映射或公网 IP**。

## 环境要求

- 客户机上需有 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（web profile）。
- 网关服务器（见 `../apps/gateway`）已运行，且客户机可访问，例如 `wss://gateway.example.com/agent`。
- 由网关管理员签发的配对码。

## 安装

```sh
dsh plugin --profile web add ./plugins/dsh-gateway-agent
```

（发布后即 `dsh plugin --profile web add dsh-gateway-agent`。）

## 使用方法

1. 向网关管理员索取配对码。
2. 打开客户机的 dsh web UI，进入 **设置 → 网关接入**。
3. 填入网关地址（`wss://<网关主机>/agent`）与配对码，点击 **发起入网申请**。
4. 网关审批通过后，插件会自动重连并保持隧道在线——此后即可从网关门户操控该机器。

## 配置

插件把配置以 JSON 形式存于 `$DSH_HOME/dsh-gateway-agent/config.json`：

| 键            | 说明                                                     |
| ------------- | -------------------------------------------------------- |
| `gatewayUrl`  | 网关 WebSocket 端点，如 `wss://gateway.example.com/agent` |
| `pairingCode` | 网关管理员签发的配对码                                     |
| `dshPort`     | 要桥接的本机 dsh web 端口（默认 `3080`）                   |

在 **网关接入** UI 里填写的值会保存到这里；`gatewayUrl` 已设置时，插件会在启动时自动连接。

## 工作原理

插件由 dsh host 面（Node）与浏览器客户端里的一张设置卡共同组成。host 面拨号 `gatewayUrl`，完成配对码 + HMAC 挑战应答，随后把来自网关的浏览器请求与 WebSocket 流中继到本机 loopback dsh web（`127.0.0.1:<dshPort>`），并注入经 dsh Connection 服务在进程内签发的操作员 cookie。

完整架构见[项目 README](../README.md)。
