# dsh-gateway-agent

[English](README.md) | 中文

[deepseek-harness-gateway](../../README.md) 的客户机接入插件。

## 它是什么

`dsh-gateway-agent` 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，装进客户机上运行的 dsh 里。它向网关发起唯一一条**出站** WebSocket，并把本机 dsh web UI 经同一条隧道桥接出去——因此客户机**无需任何入站端口、端口映射或公网 IP**。

## 环境要求

- 客户机上需有 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（web profile）。
- 网关服务器（见 `../../apps/gateway`）已运行，且客户机可访问，例如 `wss://gateway.example.com/agent`。
- 由网关管理员签发的配对码。

## 安装

```sh
dsh plugin --profile web add ./plugins/dsh-gateway-agent
```

（发布后即 `dsh plugin --profile web add @januory/dsh-gateway-agent`。）

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

插件由 dsh host 面（Node）与浏览器客户端里的一张设置卡共同组成。host 面拨号 `gatewayUrl`，完成配对码 + HMAC 挑战应答，随后把来自网关的浏览器请求与 WebSocket 流中继到本机 loopback dsh web（`127.0.0.1:<dshPort>`），并注入经 dsh Connection 服务在进程内签发的操作员 cookie。每条中继请求都会被重建为**一致的同源 loopback 请求**：除重写 `Host` 外，agent 还把 `Origin`（以及 `Referer`）声明为 `http://127.0.0.1:<dshPort>`，因此**要求 `Origin === Host` 的第三方插件路由**（例如插件市场的 POST 接口）在网关隧道下同样可用。

完整架构见[项目 README](../../README.md)。

## 守护进程服务（可选，默认关闭）

勾选 **设置 → 网关接入 → 守护进程服务** 后，本机由独立的 supervisor 进程托管 dsh 的
启动 / 停止 / 重启，网关门户的「机器目录」即可远程操作该机器。

- 插件本身跑在 dsh 里，**无法**重启 dsh——所以这一步需要把 supervisor 服务化常驻。
  现成样例见 [`service/`](service/)（systemd / launchd / Windows 计划任务）。
- 设置卡会把 supervisor 的确切启动命令显示出来，供你直接做成系统服务。
- 设置卡里展示并可修改的四条命令（启动 / 停止 / 重启 / 状态探测）就是网关将会执行的
  全部内容；**关闭就是关闭，崩溃也如实暴露**：dsh 意外退出只标成「已退出」，不会自动
  拉起，需要在机器目录点「启动」。（supervisor 自身重启或机器重启时，仍会按状态探测
  自动把 dsh 拉起。）
- 相关配置存放在 `$DSH_HOME/dsh-gateway-agent/daemon.json`；supervisor 的运行时状态写在
  同目录 `daemon-state.json`，设置卡据此显示状态。

若不需要远程启停 dsh，保持不勾选即可，其余功能不受影响。