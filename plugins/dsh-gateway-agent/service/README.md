# 守护进程服务（dsh lifecycle supervisor）

这一层让网关门户的「机器目录」可以对一台客户机执行 **启动 / 关闭 / 重启 dsh**。

## 为什么需要一个额外进程

`dsh-gateway-agent` 插件跑在 **dsh 进程内部**（ADR-0010）。dsh 一停，插件也就死了，因此
插件**永远无法**重新启动 dsh——这是把 "不自管 dsh 子进程 / 不做守护" 列为 v1 非目标的
原因。本目录交付的 supervisor（`../src/daemon.js`）补上这一层：

```
网关 ──(wss, role=supervisor)──► supervisor 进程 ──► dsh 进程
网关 ──(wss, role=console)────► 插件（在 dsh 内）──► 数据面中继
```

一台机器同时保持两条节点连接：`console`（数据面）和 `supervisor`（生命周期）。
**supervisor 必须独立于 dsh 常驻**，这样 dsh 被关闭后它仍在线，「启动」才可能——
否则 dsh 一死，网关就再也够不到那台机器。

> 所以：不要让 systemd / launchd / 计划任务 **同时** 托管 dsh 和 supervisor。
> 选一个 owner——让 supervisor 管 dsh。

## 三步接入

1. **在 dsh 设置卡里开启**：Settings → 网关接入 → 守护进程服务，勾选并保存。
   勾选会把 `$DSH_HOME/dsh-gateway-agent/daemon.json` 的 `enabled` 置为 true，
   并在卡片里展示可编辑的 **启动 / 停止 / 重启 / 状态探测脚本**（默认值按平台给）。
2. **把 supervisor 服务化**（本目录样例）：
   - Linux：`dsh-gateway-supervisor.service`（systemd **user** unit）
   - macOS：`com.januory.dsh-gateway-supervisor.plist`（launchd agent）
   - Windows：`install-supervisor-task.ps1`（计划任务）
   三者都只是「用 node 跑 `../src/daemon.js`」，按文件头注释改一处路径即可。
3. **在网关门户操作**：机器目录里该机器出现「启动 / 关闭 / 重启」按钮，
   旁边显示守护连接与 dsh 生命周期状态（运行中 / 已关闭 / 已退出 / 处理中）。

## 脚本就是你看到的那三条命令

网关不会执行任何你没见过的命令：supervisor 只运行 `daemon.json` 里
`scripts.start / scripts.stop / scripts.restart / scripts.status` 这四个字符串，
设置卡把它们原样展示、可改、可留空。

| 字段 | 作用 | 默认（POSIX / Windows） |
| --- | --- | --- |
| `scripts.start` | 启动 dsh | POSIX：`nohup dsh web --port {port} >/dev/null 2>&1 &`；Windows：调用 `dsh-lifecycle.ps1 start {port}` |
| `scripts.stop` | 停止 dsh | POSIX：`pkill -f "dsh web"`；Windows：调用 `dsh-lifecycle.ps1 stop {port}` |
| `scripts.restart` | 可选；留空 = 停止 + 启动 | 空 |
| `scripts.status` | 可选；退出码 0 表示 dsh 在运行 | POSIX：`pgrep -f "dsh web" >/dev/null`；Windows：调用 `dsh-lifecycle.ps1 status {port}` |
| `child.command` | 可选且**优先**：直接 spawn 为受管子进程 | 空 |
| `autoRevive` | dsh 意外退出时是否自动拉起 | `false`（关闭就是关闭） |
| `stopTimeoutMs` | 受管子进程 SIGTERM → SIGKILL 的宽限 | `10000` |

两种托管模式：

- **子进程模式**（填了 `child.command`）：supervisor 自己 spawn dsh，停止时精确
  `SIGTERM` → 超时 `SIGKILL`，退出即知。推荐。
- **脚本模式**（只填脚本）：supervisor 执行你的脚本，靠 `scripts.status` 判断存活。
  不填 `scripts.status` 时它只能记住自己最后一次启动/停止的结果。

## 文件

| 文件 | 说明 |
| --- | --- |
| `../src/daemon.js` | supervisor 本体（`node daemon.js`，支持 `--once` 调试） |
| `dsh-lifecycle.ps1` | Windows 生命周期助手：按命令行 `status` / `stop` / `start` dsh，永不误杀 supervisor |
| `dsh-gateway-supervisor.service` | systemd user unit 样例 |
| `com.januory.dsh-gateway-supervisor.plist` | launchd agent 样例 |
| `install-supervisor-task.ps1` | Windows 计划任务安装/卸载脚本 |

运行环境变量：`DSH_HOME` 必须与 dsh/插件一致（默认 `~/.dsh`），否则 supervisor 读不到
设置卡写入的配置。日志：未配置 `logFile` 时写 stdout/stderr，由服务管理器收集。

### 占位符

supervisor 在执行脚本前会替换这些占位符（未识别的原样保留）：

| 占位符 | 值 |
| --- | --- |
| `{port}` | dsh web 端口（取自插件配置 `dshPort`，默认 3080） |
| `{dshHome}` | dsh home（`$DSH_HOME`），脚本里最常用的那个 |
| `{home}` | 插件数据目录（`{dshHome}/dsh-gateway-agent`） |
| `{pid}` | 受管子进程 PID；脚本模式下为空 |

### Windows 为什么默认走 `dsh-lifecycle.ps1`

Windows 上**不要**用 `taskkill /f /im dsh.exe` 这类按映像名杀进程的写法：

- 从源码 checkout 跑 dsh 的机器上（`node … bin.ts web` / `pnpm dsh web`）**根本没有 dsh.exe**；
- 按名字杀还可能命中 **supervisor 自己的 node 进程**，把自己一起带走。

`dsh-lifecycle.ps1` 因此改为**按命令行匹配 dsh**，并显式排除两类进程：

1. 命令行含 `dsh-gateway-supervisor`（supervisor 自身），
2. 命令行含 `dsh-lifecycle`（脚本自身的 powershell/cmd 子进程——它的路径里也有 "dsh"）。

它支持 `status | stop | start`，`start` 会把 dsh 分离启动（`start /b`）。
如果你的 dsh 启动方式特殊，改 `-Pattern`（默认 `\bdsh\b`，前导 `\b` 是为了不误伤参数里恰好含
"dsh" 的无关进程）。