# claclaw

> 好的软件功能，总会在你需要的时候自动出现。

在手机浏览器里接管本机的 AI 编程会话。

claclaw 把本机的 AI 编程工具叫作 **Claw**，目前支持五个：[Claude Code](https://docs.claude.com/en/docs/claude-code)、DeepSeek Harness（dsh）、[OpenCode](https://opencode.ai)、[Kimi Code](https://github.com/MoonshotAI/kimi-code)、[OpenClaw](https://openclaw.ai)。**装了其中任意一个就能用**，不一定要有 Claude；装了几个，「Claw」页就列几个，随时切换。

手机上用 SSH 进终端操作这些工具很难受：没有方向键、容易断线、排版乱。claclaw 在开发机上起一个小网页服务，用手机浏览器打开就能：

- 看到本机已有的会话，选一个继续聊，或者新开一个
- 回复流式显示，工具调用以卡片展示（Edit / Write 显示红绿 diff，Bash 显示输出）
- AI 要改文件、运行命令时，底部弹出「拒绝 / 允许」大按钮，可选「本会话内同类操作都不再询问」
- 随时中断；AI 正在回复时也能接着发消息：Claude 直接插话，其他 Claw 先排队，这一轮结束后合并发出
- 会话改名、删除（Claude / DeepSeek / OpenCode 删除前先备份到 `data/trash/`，保留 30 天）
- 推送通知：回复完、等你确认、问你问题时，手机收到提醒（需要 https，iPhone 需「添加到主屏幕」）
- 语音播报（可选）：只念文字回复，或播报关键节点（等你确认、改文件/跑命令、完成）；在设置 → 语音里选「播报范围」
- 会话互发消息：同一台电脑、局域网里另一台电脑上的会话可以直接对话（见下面的「claclaw 协同」）

> 能登录 claclaw 的人，就能在你的电脑上批准任意命令。

## 各 Claw 的支持情况

| Claw | claclaw 怎么连它 | 需要的 Node | 说明 |
| --- | --- | --- | --- |
| Claude Code | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)（自带 Claude Code，要先登录过） | 18+ | 可切换权限模式（默认 / 自动改文件 / 计划）；占用检测和接管最完整 |
| DeepSeek Harness | 起 `dsh` 的 ACP 进程 | **22.15+**（会话记录是 zstd 压缩的） | `/model`、`/effort` 切模型和思考强度 |
| OpenCode | 起 `opencode acp` 进程 | **22.13+**（会话在 SQLite 库里，用 Node 自带的 `node:sqlite`） | `/model`、`/effort`、`/mode`；按目录推断终端占用 |
| Kimi Code | 起 `kimi acp` 进程 | 18+ | 不用登录 Kimi 账号：模型库里的模型自动配进去（也可以 `kimi login` 用 Kimi 会员）；`/model`、`/thinking`、`/mode` |
| OpenClaw | 连本机 OpenClaw 网关 | 18+ | 网关要开着；改文件、跑命令的确认由 OpenClaw 自己处理，网页上不弹按钮 |

- 怎么算「装了」：Claude Code 有 `~/.claude/projects`；DeepSeek 有 `~/.dsh` 或 `dsh` 命令；OpenCode 有 `opencode` 命令；Kimi Code 有 `kimi` 命令（默认装在 `~/.kimi-code/bin`）；OpenClaw 有 `~/.openclaw/openclaw.json` 或 `openclaw` 命令
- Node 版本不够时，Claw 页上那个 Claw 会写明原因；一个都没检测到时，Claw 页会提示先装一个
- 电脑上打开时默认选 Claude Code；这台电脑没有可用的 Claude Code，就自动选第一个能用的 Claw

## 要求

- macOS（目前只在 macOS 上用过）
- Node.js 18+；要用 DeepSeek / OpenCode 时按上表升级
- 至少装好并登录一个 Claw（`npm install` 会装上 Claude Agent SDK，但不用 Claude 时不需要 Claude 账号）

## 安装与启动

```bash
git clone https://github.com/wyidong/claclaw.git
cd claclaw
npm install
npm start
```

第一次用要设置登录账号，**只能用 `http://127.0.0.1:8787` 打开**（防止别人抢先设置）。运行 claclaw 的电脑没有显示器时，在你自己的电脑上开个 SSH 隧道再打开同一个地址：

```bash
ssh -L 8787:127.0.0.1:8787 用户名@那台电脑
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CLACLAW_PORT` | `8787` | 端口；也可以用命令行参数 `npm start -- --port 9000`（优先） |
| `CLACLAW_HOST` | 自动 | 逗号分隔的监听地址列表；拒绝 `0.0.0.0` / `::` |

### Claude 长期令牌

多个 Claude 会话各自刷新 claude.ai 登录，可能把刷新令牌换坏（报「OAuth session expired and could not be refreshed」）。可以给 claclaw 配一个长期令牌，所有 Claude 会话共用，不再各自刷新：

1. 在运行 claclaw 的电脑终端里运行 `claude setup-token`，按提示在浏览器里登录，复制输出的 `sk-ant-oat01-…`（一年有效）。
2. 在这台电脑的浏览器里打开 `http://127.0.0.1:8787` → 设置 → Claude 登录 → 长期令牌，粘贴保存。保存前会用它发一句话验证，用不了的不保存。
3. 没人看、也没在干活的会话进程马上换成新令牌；正打开着的会话关掉重开后生效（或者重启 claclaw）。

令牌只存在 `data/claude-token.json`（权限 600）：不写日志，网页上只显示「已配置 · 后 4 位 · 配置时间」，不经协同发出；设置、替换、清除只能在本机浏览器里做（经 clarelay、tailscale 之类转发进来的都不行）。清除后恢复用 claude.ai 登录。令牌会作为 `CLAUDE_CODE_OAUTH_TOKEN` 出现在 Claude 会话的环境变量里，所以协同消息触发的那一轮里读环境变量（`env`、`printenv`、`$变量`、`process.env`……）一律要你确认。

### 模型管理

Claw 页底部（电脑上在 设置 → 宿主 → Claw 区）有「模型管理」：登记自己买的各家模型。

- **供应商**：一家模型服务商的一个账号，填名字、接口地址（Anthropic / OpenAI / Gemini 格式，至少一个）和 key。
- **模型**：挂在供应商下面，填调用接口时用的模型 ID，可选显示名、上下文长度、能不能识图 / 推理。
- 存在电脑的 `data/models.json`（权限 600）。key 只进不出：网页上只显示后 4 位，改 key 只能整个替换或清掉，日志里不写。删掉的供应商备份在 `data/trash/`，30 天后自动清。
- **在会话里选**：dsh、OpenCode、OpenClaw 会话标题栏右边显示当前模型，点开「会话设置」就能换（不用打 `/model`），模型库里的排在前面，各 Claw 自带的在后面。这一轮回复完才能换，换了从下一条消息起生效。
  - OpenCode：启动 `opencode acp` 时把模型库注入进去（`OPENCODE_CONFIG_CONTENT`，和你自己的配置合并，供应商名前面加 `claclaw-`；有 Anthropic 格式地址优先用它），key 只放在子进程的环境变量里。模型库改了以后，等没有 OpenCode 会话开着时自动重启它的进程，才看得到新的。
  - Kimi Code：kimi 只认 `~/.kimi-code/config.toml`，claclaw 把模型库写成里面 `claclaw-` 开头的供应商和模型（OpenAI 兼容地址优先），key 不写文件（`api_key_env` 指向环境变量，只在 claclaw 起的 `kimi acp` 里有）；你自己的配置原样保留，没设默认模型时设成模型库第一个。所以终端里直接跑 `kimi` 用不了这些模型（没有 key）。
  - dsh、OpenClaw：用它们自己配好的供应商，按「同一个接口地址 + 同一个模型 ID」认出哪些是模型库里的模型。
  - OpenClaw 只能换成它放行（`agents.defaults.models`）的模型；模型库里有、它没放行的会灰着显示。要放行得改 OpenClaw 自己的配置，并让网关重新加载。
  - Claude 会话还是用自己的模型选择（Claude 账号里的模型）。

## 会话占用与接管

下面说的是 Claude Code。OpenCode 按目录推断终端占用（见「目前的限制」）；DeepSeek 不检测占用，别在终端和网页里同时开同一个会话；OpenClaw 的会话都由它的网关管理，claclaw 只是网关的一个客户端。

同一个会话不能同时被两个 Claude Code 进程操作：两边内存里的上下文互不知道，会话记录（`~/.claude/projects/**.jsonl`）会分叉。claclaw 读取 `~/.claude/sessions/` 下的运行中会话登记表来判断占用：

- 会话正在 VS Code / 终端里打开、且最近 N 分钟内有活动 → 网页端不能打开（N 在「设置 → 会话」里改，默认 30）
- 原处闲置超过这个时间、状态为空闲 → 网页端可以**接管**：确认后结束原处的进程，由网页打开（结束前会核对进程启动时间，防止 pid 复用误杀）
- 网页打开期间，如果在原处重新打开了这个会话 → 网页端自动退出，以原处的操作为准
- 网页端没人看、也没在运行时，过一段时间关闭进程，把会话还给终端（「设置 → 会话」里改，默认 10 分钟）

## claclaw 协同：两台电脑的会话互发消息

让局域网里两台电脑上的 AI 会话直接对话：你这边的会话有问题可以直接问对方电脑上的会话，对方的回复自动回到你这边；两边的人在 claclaw 网页上都能看到它们在聊什么，随时插话或叫停。

四个 Claw（Claude Code、DeepSeek、OpenCode、OpenClaw）的会话都能加入协同，**同一台电脑上的会话之间也能互相找**：
- **收**：别的会话的消息由 claclaw 送进会话，这一轮的回复自动传回去。
- **发**：Claude 会话用内置的 `peer_sessions` / `peer_send` 工具（`peer` 填「本机」就是找本机的会话）；其他 Claw 的 AI 用 claclaw-peer 技能，也就是本机命令 `~/.claclaw/bin/claclaw-peer`（`whoami` / `list` / `send` / `result`）。技能在用上这个 Claw 时自动装好，不用你操作。
- **规矩**：本机的会话之间都能互相找；找另一台电脑，发起的会话要加入协同池，且只能找开放了它的对方。发起方必须认得出是哪个会话：命令不写 `--from` 时，claclaw 按「命令在哪个目录跑 + 哪个会话正在回复」自动认，认不出就拒绝。（这是用法上的规矩，不是安全边界：本机以你的身份运行的程序本来就读得到 claclaw 的数据。）

- **只走局域网**：两台电脑连着同一个 Wi-Fi / 内网就行，**不需要 Tailscale**
- **像蓝牙配对**：对方申请 → 你这边页面上出现一个两位数配对码 → 你把码告诉对方 → 配对完成；之后用钥匙通信，不用再输码
- **按电脑名找、自动发现**：开着协同的 claclaw 会在局域网里广播自己（Bonjour / mDNS），协同页「附近的 claclaw」直接列出来，点一下就申请配对；地址用「电脑名.local」，路由器换了 IP 也不用重新配对，名字找不到时自动退回 IP
- **对方不一定要装 claclaw**：任何能发 HTTP 请求的程序按下面的接口实现即可

### 开启（我们这边）

1. 打开协同页（宿主 › claclaw 协同）。手机上（包括经中继打开的网页）也能做全部操作：开关协同、配对、撤销、开放哪些会话
2. 进入「**宿主 → 网络 → claclaw 协同**」
3. 「我们这边」：
   - **名字**：显示在对方那边，默认是电脑名
   - **端口**：默认 `8788`（和网页的 8787 分开，局域网上只开放协同接口，网页不会暴露到局域网）
   - **会话目录**：选一个目录，再勾选要加入协同的会话（可以多选）。对方发来的消息只会送进这些会话
4. 点「**开启协同**」。状态显示「已开启，正在接收」后，下面会出现我们的协同地址（电脑名版和 IP 版），例如：

   ```text
   http://MacBook-Pro.local:8788/claclaw-peer
   http://192.168.1.178:8788/claclaw-peer
   ```

   地址里不含密码，别人拿到也只能申请配对。点「**复制邀请（含配对说明）**」，把整段发给对方（里面有完整的接口说明）。

关闭：点「关闭协同」，8788 端口立刻关掉；设置会保留，claclaw 重启后按上次的开关状态自动恢复。

### 配对

**对方来申请**（对方用 claclaw 时，他的协同页「附近的 claclaw」里会列出我们，点「申请配对」即可；列不出来就在「向对方申请配对」里填我们的地址）：

1. 我们这边协同页顶部出现「配对申请」：对方的名字、IP、一个**两位数配对码**、剩余时间；这台电脑会响一声，手机也会收到推送（点通知直接打开协同页）
2. 核对 IP 和名字是你认可的电脑，把两位数**告诉对方**（微信、口头都行）——这一步就是「同意」
3. 对方填对码，配对完成，出现在「已配对」列表里，带在线绿点

不认识的申请点「拒绝」，或者不理它：配对码 5 分钟过期。

配对码两位数，方便口传。防乱试靠输错冷却：填对立刻配上；填错不马上说错，对方页面显示「配对中」，冷却结束才告诉他「配对码错误，配对失败」，要重新申请。冷却不分 IP、全局算：第 1 次错 30 秒，第 2 次 3 分钟，第 3 次 30 分钟，之后每次 2 小时（24 小时没再错就清零）；冷却期间谁都配不了。90 种码平均要试 45 次，算下来要八十多个小时。另外同一个 IP 10 秒内只能申请一次，全局每小时最多 30 次申请。

> 配对码从六位改回两位、输错改成冷却，**两边的 claclaw 都要升级**。

**我们去申请**：在「附近的 claclaw」里点对方的「申请配对」（或在「向对方申请配对」里手动填对方的协同地址）→ 问对方要他页面上的两位数 → 填进去点「完成配对」。

配对是双向的：申请时双方交换收件地址，完成后两边都能主动找对方。

### 配对之后

- 加入协同的会话能找对方：Claude 会话里多了 **`peer_sessions`**（看对方开放了哪些会话）和 **`peer_send`**（给对方发一条消息，等对方这一轮回复完，拿到回复原文）两个工具，其他 Claw 用 claclaw-peer 技能。直接对会话说「问一下对方……」即可
- 对方发来的消息会送进我们加入协同的会话，开头带「【claclaw 协同 · 来自对方：…】」；这一轮回复完，回复原文自动返回给对方
- 「已配对」列表里每 10 秒检查一次对方在不在线（绿点 = 在线）；点「撤销」立即断开，对方要重新申请

### 对方不用 claclaw 时的接口

协同地址记为 `BASE`（例如 `http://192.168.1.178:8788/claclaw-peer`）：

| 步骤 | 请求 | 返回 |
| --- | --- | --- |
| 申请配对 | `POST BASE/pair` `{"name":"你的名字","inbox":"你的收件地址（可选）","inboxAlt":"备用地址（可选）"}` | `{"requestId"}` |
| 确认配对 | `POST BASE/pair/confirm` `{"requestId","code":"两位数","token":"可选：以后我们找你用的钥匙"}` | `{"token","name","inbox","inboxAlt"}`；输错回 202 `{"pairing":true,"retryIn":秒}`，隔这么久用同一个 requestId 再调，回 403「配对码错误，配对失败」 |
| 查看会话 | `GET BASE/sessions`，请求头 `Authorization: Bearer <token>` | `{"sessions":[{"id","title","busy"}]}` |
| 发消息 | `POST BASE`，同上请求头，`{"from","text","session?","msg_id?","sent_at?","from_session?"}` | `{"ok","reply"}`；60 秒内写不完先回 202 `{"ok":true,"accepted":true,"id"}`，回复写完后另发一条到你的 `from_session`，正文开头写「回复 <id>」 |

错误码：400 消息为空或没指定会话，401 没配对或钥匙不对，409 会话正忙或被终端占用，413 太长（4000 字以内），429 上一条还在处理，504 超时。

- `msg_id`：这条消息的编号，重发时不变。我们按「对方 + msg_id」去重，保留 24 小时并落盘（重启后也认得），重复的直接返回上次的结果并带 `"duplicate":true`
- `sent_at`：第一次发送的时间，ISO 8601 带时区（如 `2026-10-30T16:50:00+08:00`），重发时不变。送达时晚了 5 分钟以上，交给会话时注明「X 前发出」
- 连不上就排队重发（两边同一套规则）：只在拒绝连接、超时、中继报对方不在线（502 / 503 / 504）时排队，间隔 1、2、5、10 分钟，之后每 10 分钟，带抖动，最长 24 小时，队列落盘；409、额度以外的 429 隔 1 分钟重试，最多 5 次；400 / 401 / 404 / 413 不重试。排队中的消息在协同页能看到、能取消

### 安全

- **钥匙只存哈希**：我们发给对方的钥匙，本机只存它的哈希（像网站存密码），`data/peer.json` 被看到也拿不出能用的钥匙；对方给我们的钥匙存原文（每次访问对方要带上），`data/` 只有本人可读、不进 git
- **外部消息 = 别人的指令**：对方发来的消息触发的那一轮（Claude 会话），不管权限模式是什么（包括「跳过确认」），有风险的操作都要你在网页上确认：运行只读命令（`ls`、`git status/log/diff/pull`、`grep` 等；pull 只认 origin）、读普通文件、改本项目目录里的文件直接放行；claclaw 仓库没有未提交改动时，常规维护 `npm run check`、`npm test`、`npm run restart`（等所有会话空闲再重启）也直接放行；其余命令、改目录外的文件、读钥匙密码等敏感位置（`~/.ssh`、`data/`、`.env`、shell 启动文件和命令历史……）、展开或列出环境变量（`$HOME` 等少数几个除外；环境里有 Claude 长期令牌，一律确认、不交给审查模型）、联网，都要确认，可以选「本轮同类都允许」。本机会话在处理对方消息时转给别的会话的消息也一样。DeepSeek / OpenCode / OpenClaw 会话还没有这层保护，加入协同时不要开「跳过确认」
- 局域网明文 http，只在信任的网络里用；不要把 8788 映射到公网

### 常见问题

- **对方连不上**：确认两台电脑在同一个局域网；路由器的「访客网络 / 设备隔离」会让电脑之间互相访问不了
- **「附近的 claclaw」是空的**：有的网络屏蔽 Bonjour 广播，手动填对方的 IP 版地址即可；自动发现目前只在 macOS 上做了
- **IP 变了**：配对时双方交换的是电脑名地址，一般不用管；我们这边 IP 变了时，在协同页点一下「保存」（或重启 claclaw）让 8788 开到新 IP 上。如果网络屏蔽了按名字找，就只能靠 IP，那时 IP 一变要重新配对，可以在路由器里给两台电脑设固定 IP
- **端口被占用**：协同页会提示，换一个端口再「保存」

## 安全

- **权限继承原会话**（Claude Code）：网页打开会话时，继承它在原处（VS Code / 终端）最后一次使用的权限模式，并像 `claude --resume` 一样加载用户、项目、本地设置；从没在别处用过的会话按默认模式打开。模式按钮可以在 默认 / 自动改文件 / 计划 / 自动判断 / 不询问 / 跳过确认 之间切换（每个会话都能选）：切到「跳过确认」（`bypassPermissions`）要先确认，这一轮结束后会重启这个会话的进程（聊天内容不变），并记住这个选择，以后再打开也是跳过确认，直到你切回别的模式。跳过确认后，运行命令、改文件都不再询问，加入协同的会话尤其要慎用
- **WebSocket 同源检查**：浏览器不对 WebSocket 做同源限制，claclaw 只接受 Origin 与 Host 一致的连接，防止其他网页在后台连进来
- 不监听 `0.0.0.0`；传输是 http，**不要把端口暴露到公网**

## 目前的限制

- 过程播报/自动朗读需要页面保持在前台（屏幕可以常亮）。锁屏或切到后台后语音会停止，重要节点改用系统推送通知。
- 其他会话通过 Claude Code 内置的跨会话消息发来的消息，如果因权限模式不同被扣住，网页上只显示提示，暂不能批准
- DeepSeek 改名：需要先关闭这个会话在 dsh web / 终端里的写入方；网页里打开的会话要先切走（claclaw 会先关掉网页里的 runner，再拿 dsh 的 `session.lock`）。改名前的日志备份在 `data/trash/`。
- Kimi Code 会话：不检测终端占用，别在终端和网页里同时给同一个会话发消息；改名按 kimi `/title` 的做法写会话的 `state.json`（之后自动标题不会盖掉；终端里正开着同一会话的要重开，不然会被它写回旧名）；删除前先 `kimi export` 成 zip 放到 data/trash
- OpenCode 会话（需要 Node 22.13+ 的 `node:sqlite`）：opencode 不登记哪个进程开着哪个会话，claclaw 按目录推断终端占用——终端 opencode 开着的目录里、它启动后改动过的最新会话视为被占用；接管会结束该目录的终端 opencode。终端里之后再打开同一会话，网页端不会自动退出。改名走 opencode 自己的本机接口（终端里开着同一会话的要重开才看到新名）；删除前先导出到 data/trash（`opencode import` 可找回）

## 技能

仓库的 `skills/` 里预先准备了一些 [Agent Skills](https://agentskills.io)（`SKILL.md` + 脚本），平时不用管：用到相关功能时 claclaw 自动装好，不用你点。全部技能在 设置 › 宿主 › 技能 里能看、能装、能卸。

- 装到两个位置就覆盖四个 Claw：`~/.claude/skills`（Claude Code，OpenCode 也读）和 `~/.agents/skills`（DeepSeek、OpenCode、Kimi、OpenClaw 共用）。
- 装的是复制件，带 `.claclaw-skill` 标记；claclaw 启动时会把它们同步成仓库里的最新版。卸载只删带标记的，你自己的同名技能不会被覆盖或删除。
- 技能里的命令只和本机 claclaw 通信：地址和本机令牌在 `~/.claclaw/local.json`（只有本人可读），本地接口只接受 127.0.0.1 带令牌的请求；配对的钥匙始终只在 claclaw 里。

| 技能 | 什么时候推荐 | 作用 |
| --- | --- | --- |
| `claclaw-peer` | 第一次在 claclaw 里用 DeepSeek / OpenCode / OpenClaw 的会话，或它们收到别的会话的消息时自动装 | 让 AI 找本机其他会话、另一台电脑上的会话，发消息、拿回复 |

新场景：在 `skills/` 里加一个技能目录，在 `skills/index.json` 里登记，再在服务端用到它的地方调一次自动安装（参照 `ensureSkill`）。

## 文件

```text
server.mjs        HTTP + WebSocket 服务、会话列表、权限转发；Claude Code 会话（Agent SDK）和接管
openclaw.mjs      OpenClaw 会话（通过本机 OpenClaw 网关）
dsh.mjs           DeepSeek Harness 会话（读 dsh 会话记录 + dsh ACP）
opencode.mjs      OpenCode 会话（只读 opencode 的 SQLite 库 + opencode ACP；按目录推断终端占用、接管）
peer.mjs          claclaw 协同：局域网收件服务、配对、请求对方
skills.mjs        技能：安装 / 卸载 / 启动时同步，本机令牌和 ~/.claclaw/bin 命令
skills/           预先准备的技能（index.json 登记；claclaw-peer：协同收发命令）
host.mjs          「宿主」页：电脑、资源、网络、各 Claw 状态
tts.mjs           电脑合成语音（微软在线语音 / macOS say）
auth.mjs          登录
push.mjs          推送通知（Web Push）
passwd.mjs        命令行改登录账号
public/           前端（单文件页面 + 登录页 + 主屏幕图标）
tools/make-icons.py  生成主屏幕图标（python3 + Pillow）
tools/setup-edge-tts.sh   装 / 升级微软在线语音（在 data/edge-tts 里建 Python 环境）
tools/edge-tts-helper.py  微软在线语音的常驻合成助手
probe/            开发时用来核实 SDK 行为的探针脚本
claude-session-demo.html  最初的纯前端交互演示（预设脚本，不连后端）
```
