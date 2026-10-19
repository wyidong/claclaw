# claclaw

在手机浏览器里接管本机的 [Claude Code](https://docs.claude.com/en/docs/claude-code) 会话。

手机上用 SSH 进终端操作 Claude Code 很难受：没有方向键、容易断线、排版乱。claclaw 在开发机上起一个小网页服务，用手机浏览器打开就能：

- 看到本机已有的 Claude Code 会话，选一个继续聊（等同 `claude --resume`）
- 回复流式显示，工具调用以卡片展示（Edit / Write 显示红绿 diff，Bash 显示输出）
- Claude 要改文件、运行命令时，底部弹出「拒绝 / 允许」大按钮，可选「本会话内同类操作都不再询问」
- 切换权限模式（默认 / 自动改文件 / 计划）、随时中断
- 推送通知：Claude 回复完、等你确认、问你问题时，手机收到提醒（需要 https，iPhone 需「添加到主屏幕」）

> 能登录 claclaw 的人，就能在你的电脑上批准任意命令。

## 要求

- macOS（目前只在 macOS 上用过）
- Node.js 18+
- 已登录的 Claude Code（claclaw 通过 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 驱动会话，SDK 自带 Claude Code 二进制）

## 安装与启动

```bash
git clone https://github.com/wyidong/claclaw.git
cd claclaw
npm install
npm start
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CLACLAW_PORT` | `8787` | 端口；也可以用命令行参数 `npm start -- --port 9000`（优先） |
| `CLACLAW_HOST` | 自动 | 逗号分隔的监听地址列表；拒绝 `0.0.0.0` / `::` |
| `CLACLAW_TAKEOVER_MIN` | `30` | 会话在原处闲置多少分钟后，网页端才能接管（默认值；网页「设置 → 会话」里可以改） |

## 会话占用与接管

同一个会话不能同时被两个 Claude Code 进程操作：两边内存里的上下文互不知道，会话记录（`~/.claude/projects/**.jsonl`）会分叉。claclaw 读取 `~/.claude/sessions/` 下的运行中会话登记表来判断占用：

- 会话正在 VS Code / 终端里打开、且最近 N 分钟内有活动 → 网页端不能打开（N 在「设置 → 会话」里改，默认 30）
- 原处闲置超过这个时间、状态为空闲 → 网页端可以**接管**：确认后结束原处的进程，由网页打开（结束前会核对进程启动时间，防止 pid 复用误杀）
- 网页打开期间，如果在原处重新打开了这个会话 → 网页端自动退出，以原处的操作为准
- 网页端没人看、也没在运行时，过一段时间关闭进程，把会话还给终端（「设置 → 会话」里改，默认 10 分钟）

## 安全

- **权限与原会话一致**：网页打开会话时，继承它在原处（VS Code / 终端）最后一次使用的权限模式，并像 `claude --resume` 一样加载用户、项目、本地设置。只有原会话本来就是 `bypassPermissions` 时网页才会处于该模式；从没在别处用过的会话按默认模式打开。模式按钮只能在 默认 / 自动改文件 / 计划 和继承来的模式之间切换
- **WebSocket 同源检查**：浏览器不对 WebSocket 做同源限制，claclaw 只接受 Origin 与 Host 一致的连接，防止其他网页在后台连进来
- 不监听 `0.0.0.0`；传输是 http，**不要把端口暴露到公网**

## 目前的限制

- 其他会话通过 Claude Code 内置的跨会话消息发来的消息，如果因权限模式不同被扣住，网页上只显示提示，暂不能批准

## 文件

```text
server.mjs        HTTP + WebSocket 服务，会话管理（SDK query）、权限转发、接管
auth.mjs          登录
push.mjs          推送通知（Web Push）
passwd.mjs        命令行改登录账号
public/           前端（单文件页面 + 登录页 + 主屏幕图标）
tools/make-icons.py  生成主屏幕图标（python3 + Pillow）
probe/            开发时用来核实 SDK 行为的探针脚本
claude-session-demo.html  最初的纯前端交互演示（预设脚本，不连后端）
```
