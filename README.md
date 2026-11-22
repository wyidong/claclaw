# claclaw

claclaw 是装在电脑上的一个小网页服务，让你用手机浏览器接管这台电脑上的 AI 编程会话：看已有会话、接着聊或新开一个，AI 要改文件、跑命令时在手机上点「允许 / 拒绝」，回复完收到推送。不用 SSH，不怕断线。

它把本机的 AI 编程工具叫作 **Claw**，支持 Claude Code、DeepSeek Harness、OpenCode、Kimi Code、Qwen Code、Codex、GLM Agent、iFlow CLI、MiniMax Code、CodeBuddy Code、Qoder CLI、GitHub Copilot CLI、OpenClaw，以及自带的 kuAi（问答为主；小模型说一句「放首歌」「打开四川卫视」由程序代填参数去用技能，能力够的模型自己用技能、跑几条简单命令，再强一些的还能读文件、在目录里搜内容、看网页，只读不改；放开到哪一步由 6 道题的上岗小测验实测决定，也可以在模型管理里逐个改。没装 DeepSeek Harness 时对它说「帮我装 DeepSeek」，点一下确认就装）。装了任意一个就能用，装了几个就能随时切换。两台电脑上的会话还能互发消息、拉进同一个群聊协作。

> 能登录 claclaw 的人，就能在你的电脑上批准任意命令。

## 安装

要求：macOS 或 Windows，Node.js 18+（DeepSeek、OpenCode、MiniMax Code 要 22.13+，Copilot CLI 要 22+）。

```bash
git clone https://github.com/wyidong/claclaw.git
cd claclaw
npm install
npm start          # 默认端口 8787；换端口：npm start -- --port 9000
```

- **第一次打开**：在这台电脑上用 `http://127.0.0.1:8787` 打开，或用手机打开（第一台打开的设备免登录）。进去后按提示设登录账号，设好后所有设备都用这组账号登录。以后改账号：`npm run passwd -- <用户名> <密码>`。
- **还没装 DeepSeek Harness**：Claw 页有它的卡片，点「安装」自动装好，填好 key 后直接开会话（电脑上一个 Claw 都没有时，Claw 入口会亮红点提示）。
- **手机怎么连上**：网页默认只监听本机和 Tailscale 地址。装了 Tailscale 就用电脑的 Tailscale 地址打开；没有就用 clarelay（见下），或 SSH 隧道 `ssh -L 8787:127.0.0.1:8787 用户名@那台电脑`。要在局域网里直接打开，用 `CLACLAW_HOST=127.0.0.1,<局域网 IP>` 指定监听地址（不接受 `0.0.0.0`）。

## 功能

### 会话

- 列出各 Claw 在本机的已有会话，接着聊或新开；回复流式显示，工具调用显示成卡片（改文件看红绿 diff，跑命令看输出）。
- 回复里的 B 站、YouTube 等视频 / 音频链接显示成播放卡片，点一下在会话里直接播放；AI 发来的图片、视频、文档能直接看。
- 随时中断；AI 回复中也能接着发消息：Claude 直接插话，其他 Claw 排队，这一轮结束后发出。
- 改名、删除。删除前备份到 `data/trash/`，保留 30 天（Codex、MiniMax 用它们自己的归档）。
- **占用与接管**（Claude Code）：会话正在终端 / VS Code 里用着时网页打不开；那边闲置超过设定时间（默认 30 分钟）可以接管；网页没人看时过一阵把会话还给终端。OpenCode 按目录推断占用，其他 Claw 不检测，别在终端和网页里同时开同一个会话。

### 权限确认

AI 要改文件、跑命令时，手机上弹出「允许 / 拒绝」，可选本会话内同类操作不再询问。Claude 会话可以切换权限模式（默认、自动改文件、计划、跳过确认等）；打开时继承它在终端里最后用的模式。

### 模型库

在「模型管理」里按 Key 登记自己买的各家模型（填 Key 和接口地址，模型列表自动读）。各 Claw 的会话设置里能直接选这些模型，claclaw 按各家的方式配进去，key 不写进日志。Key 只显示后 4 位，查看或复制完整 Key 要再输一次登录密码。存在 `data/models.json`（只有本人可读）。

### 在手机上登录各 Claw

Qoder、CodeBuddy、Kimi、Codex、MiniMax Code、Copilot 等要账号登录的，在 Claw 卡片上点「登录」：claclaw 在电脑上起登录命令，把授权网址和一次性代码推到手机，手机上点开授权即可。GLM Agent、iFlow、DeepSeek 在手机上填 API key。

### Claude 长期令牌

多个 Claude 会话各自刷新登录可能互相顶掉（报「OAuth session expired」）。在电脑上运行 `claude setup-token`，把得到的令牌粘贴到 Claw 页 Claude 卡片的「长期令牌」里，所有 Claude 会话共用。令牌只在本机浏览器里设置，复制要输密码。

### 推送和语音

回复完、等你确认、问你问题时手机收到推送（需要 https：clarelay 或 `tailscale serve`；iPhone 要「添加到主屏幕」）。可选语音播报文字回复或关键节点（页面要在前台）。

### clarelay：从外网访问（可选）

clarelay 是可选的第三方中继。在「设置 → 宿主 → 网络 → clarelay」粘贴设备邀请码后，手机在外网也能打开 claclaw；没填邀请码时，claclaw 不下载、不连接 clarelay 的任何东西。电脑端程序从加入的中继下载，用邀请码里的发布公钥验过签名才用，有新版时宿主页出现「更新」。

### claclaw 协同：会话互发消息

让会话直接找别的会话：同一台电脑上的会话之间，或局域网里另一台电脑上的会话。你这边的会话可以直接问对方的会话，回复自动传回来，两边网页上都看得到、能插话。

- **开启**：「宿主 → 网络 → claclaw 协同」，选要加入的会话，点「开启协同」（端口 8788）。
- **配对**：「附近的 claclaw」里点对方「申请配对」；对方点「同意」后看到两位数配对码，口头告诉你，填上即配好。配好后两边都能主动找对方。
- **怎么用**：Claude 会话直接说「问一下对方……」（内置 `peer_sessions` / `peer_send` 工具）；其他 Claw 用自动装好的 claw-interconnect 技能。
- **不在一个网络**：自动走 clarelay 中继或打洞直连（都加密）。
- **安全**：对方的消息当作别人的指令。不管会话是什么权限模式，有风险的操作（改项目外的文件、读密钥、联网、删除、push……）都要你确认，只读命令和项目内改文件直接放行。配对钥匙只存哈希，不会明文发到公网地址。

### 群聊

把几个会话（本机任意 Claw 的、协同对方开放的）拉进一个群，对话集中在一处看。

- 「最近」页点「建群」选成员；群和会话一起列在「最近」里，删除即解散。
- @ 谁谁回一轮，`@全体` 全员回；没 @ 人的消息交给主理人（群设置里指定）。
- 成员回复里 @ 别的成员会自动转过去，最多连着转 5 次。
- 拉了另一台电脑会话的群，对方的「最近」里也会出现。

### 技能

`skills/` 里预备了 Agent Skills（claw-interconnect：找别的会话；claw-file：把图片、视频、文档发到手机上看；影音组的 claw-video / claw-music / claw-audio / claw-movie / claw-image / claw-tv：从多个网站找视频、纯音频的歌、MV、官方免费电影、图片，看电视直播），用到相关功能时自动装进 `~/.claude/skills` 和 `~/.agents/skills`，所有 Claw 都能用；在「设置 → 宿主 → 技能」里能看、能装、能卸，不会碰你自己的同名技能。

## 安全提示

- 网页默认只监听本机和 Tailscale 地址，传输是 http：不要把 8787 / 8788 端口暴露到公网，外网访问用 clarelay。
- 「跳过确认」模式下 AI 跑命令、改文件都不再询问，加入协同的会话慎用。
- 数据都在 `data/`（只有本人可读，不进 git）。

## 协同接口（对方不用 claclaw 时）

协同地址记为 `BASE`（例如 `http://192.168.1.178:8788/claclaw-peer`），开启协同后点「复制邀请」可以拿到完整说明。

| 步骤 | 请求 | 返回 |
| --- | --- | --- |
| 申请配对 | `POST BASE/pair` `{"name","inbox?","inboxAlt?"}` | `{"requestId"}` |
| 确认配对 | `POST BASE/pair/confirm` `{"requestId","code","token?"}` | `{"token","name","inbox","inboxAlt"}`；输错回 202 `{"pairing":true,"retryIn"}` |
| 查看会话 | `GET BASE/sessions`，头 `Authorization: Bearer <token>` | `{"sessions":[{"id","title","busy"}]}` |
| 发消息 | `POST BASE` `{"from","text","session?","msg_id?","sent_at?","from_session?"}` | `{"ok","reply"}`；60 秒内写不完先回 202 `{"accepted":true,"id"}`，回复写完另发到你的 `from_session`，开头写「回复 <id>」 |

- 错误码：400 消息为空，401 钥匙不对，409 会话忙，413 超过 4000 字，429 上一条还在处理，504 超时。
- `msg_id` 用来去重（24 小时），`sent_at` 用 ISO 8601 带时区；重发时两个都不变。
- 群聊：消息的 `from_session` 是群编号 `gp-xxxxxxxx`。回复发到 `{"session":"gp-xxxxxxxx","reply_to":"<msg_id>","text"}`；不带 `reply_to` 就是在群里发言；读群记录 `GET BASE/group?id=gp-xxxxxxxx&after=序号&limit=条数`。

## 目录

```text
server.mjs     入口：HTTP + WebSocket、会话列表、Claude Code 会话
src/claws/     各 Claw 的接入（ACP 的都继承 acp.mjs）、登录、安装
src/peer/      协同、群聊、权限审查、clarelay
src/           登录账号、模型库、推送、语音、技能等
public/        前端
skills/        预备的技能
tools/         开发和运维脚本（npm run check / restart）
test/          测试（npm test）
```
