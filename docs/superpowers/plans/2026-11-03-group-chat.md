# claclaw 群聊 第一版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 claclaw 里建群：成员是本机 / 协同的任意会话，@ 触发成员回一轮，回复贴回群里；拉了协同会话的群在对方电脑「最近」里自动出现镜像。

**Architecture:** 新文件 group.mjs 放群的数据和规则（存储、@ 解析、带上下文、跳数、排队重试），投递和镜像同步通过注入的函数做，便于单测。server.mjs 把群当成一种「会话」接进现有 ws（session.open / message.send / history.more）、「最近」列表、未读推送，并给协同口加 `/group` 子路由和群回复（202 之后）的回落。前端 index.html 加建群按钮、选成员面板、群消息渲染、@ 弹层。

**Tech Stack:** Node（node:test）、单文件前端（原生 JS）。

**Spec:** docs/superpowers/specs/2026-11-03-group-chat-design.md

## Global Constraints
- 群 id：`gp:` + 8 位十六进制；经协同传时写成 `gp-xxxxxxxx`（对方会把 from_session 里 [\w-] 以外的字符去掉）。
- 单次投递 ≤ 4000 字：本条原样，附带群记录从最旧的截短（每条 ≤ 300 字）或丢弃；附带记录最多 20 条。
- 成员互相 @ 最多转 2 跳；成员不能 @ 自己。
- 用户在本机群里 @ = 用户指令（不加「只能提需求」、不设 peerTurn）；成员之间、跨电脑来的（镜像里发的、发给协同成员的）按现有协同规矩。
- 群收协同消息只收「对自己发出消息的回复」（reply_to 在待回复表里、来自同一个对方）；群不出现在对方能看的会话列表里。
- 记录存 data/groups/<hex>.json（镜像同目录，带 mirror 字段），条目最多留 500。
- 提交前 `npm run check && npm test`。

## Review Focus
- 成员会话名重复 / 含空格：@ 解析取最长匹配，重名自动加序号。
- 成员正忙（本机 409、协同 429 / busy）：排队每 20 秒重试，最长 30 分钟，群里显示「在忙，排队中」。
- 协同成员 60 秒内没回完（202）：回复稍后以「回复 <编号>」发到 `gp-…`，要落回群里并继续处理它里面的 @。
- 对方是旧版本：/group 404 时镜像同步静默失败，群本身照常。
- 解散：任一边从「最近」删 = 两边都删；删后再来的同步 / 回复丢弃。

---

### Task 1: group.mjs 核心（纯逻辑 + 存储）
**Files:** Create `group.mjs`; Test `test/group.test.mjs`
**Produces:**
- `isGroupId(id) → bool`、`toWire(id) → 'gp-…'`、`fromWire(s) → 'gp:…'|null`
- `memberNames(members) → members`（补 name：标题压空格、截 16 字、重名加序号）
- `parseMentions(text, members) → key[]`（`@全体`/`@all` = 全部；最长名优先）
- `composeDelivery({items, since, upto, selfKey, members, current, limit=4000}) → string`
- `class Groups({dir, log, deliver, syncOut, onItem, onChange})`：`create({name, members})`、`get(id)`、`list()`、`post(id, text, {via})`、`remoteReply(id, peerId, replyTo, text)`、`applyMirror(peerId, snap)`、`dissolve(id, {fromPeer})`、`snapshotFor(id, peerId)`
- Group 对象（给 ws 用）：`id, title, subs, subscribe, unsubscribe, watched, emit, send(text)→true, history()→{items,total}, busy=false, pending=new Map(), queue=[], interrupt(), replyPermission(), closed`
- [ ] 测试：mentions（最长匹配、@全体、不 @ 自己）、composeDelivery（截短到 4000、最多 20 条、排除自己的话）、跳数（第 3 跳不转）、忙重试、202 回落、解散后丢弃
- [ ] 实现 → 测试通过 → 提交

### Task 2: server 接线（本机可用）
**Files:** Modify `server.mjs`
- peerDeliver 加 `group: {name, asUser}` 选项：群专用开头；asUser 时不加「只能提需求」、不设 peerTurn；群投递不给成员会话单独推送。
- deliver(member, text, opts)：本机成员走 peerDeliver(local)，协同成员走 peerCall（body 带 `group`）。
- ws：session.open 遇 gp: → 群；message.send 群里不收图片 / 视频 / 文件；history.more 群分页。
- /api/recent 混入群（claw:'group'，lastPrompt「谁：说的」）；/api/recent/hide 对群 = 解散。
- /api/group/candidates（本机会话 + 各对方 /sessions）、/api/group/create。
- 群新消息：没人看着就记未读 + 推送（alertOut），镜像那边只记未读。
- [ ] 临时实例里建群（两个本机会话），@ 一个能回、互相 @ 能转 → 提交

### Task 3: 协同（跨电脑 + 镜像）
**Files:** Modify `server.mjs`
- 收信口：body.group → 群开头 + 协同规矩；session 是 `gp-…` 且带 reply_to → Groups.remoteReply。
- `/group` 子路由：op sync（建镜像 / 更新）、post（镜像里发的 → 主群）、dissolve。
- 群有变化 → 对每个有成员的对方推 snapshotFor（300ms 合并）。
- [ ] 本机 ↔ 15 实测：建群拉 15 的会话，15「最近」出现，@ 15 成员能回，15 里发消息主群收到，任一边删两边都没 → 提交

### Task 4: 前端
**Files:** Modify `public/index.html`、`public/i18n/en.js`
- 「最近」搜索框左边建群按钮（宽 46px，同 logo），只在「最近」显示。
- 选成员面板：本机（Claw logo + 名）、协同（Claw logo + 协同标识 + 名 + 对方名），可搜，选 ≥2 个；群名可空。
- CLAW_T 加 `{id:'group',p:'gp',name:'群聊'}`；clawIcon('group') 用群图标。
- 群聊页：成员消息靠左带 logo / 协同标识 / 名字；状态行「X 正在回复… / 在忙，排队中」；隐藏会话设置按钮；输入 @ 弹成员列表（含 @全体）。
- [ ] 无头浏览器截图检查建群、群聊页、@ 弹层 → 提交

### Task 5: 上线
- [ ] push，本机闲时重启，15 pull 重启，和用户一起试
