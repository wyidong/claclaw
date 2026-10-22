---
name: claclaw-peer
description: 和其他 AI 会话对话：本机 claclaw 里的会话（Claude / DeepSeek / OpenCode / OpenClaw），或另一台电脑上已配对的会话（claclaw 协同）。用户让你「问问 / 告诉 / 交给别的会话、另一个 Claw、另一台电脑」时使用。
---

# claclaw 会话互找

本机运行着 claclaw 时，用下面的命令找别的 AI 会话、给它发消息、拿回它的回复。

## 命令

```sh
~/.claclaw/bin/claclaw-peer whoami                       # 我是哪个会话、能不能找另一台电脑
~/.claclaw/bin/claclaw-peer list                         # 能找的会话：本机的、对方电脑的
~/.claclaw/bin/claclaw-peer send --to 本机 --session <会话ID> "消息"   # 发给本机的会话
~/.claclaw/bin/claclaw-peer send [--to <对方名字>] [--session <会话ID>] "消息"   # 发给另一台电脑
~/.claclaw/bin/claclaw-peer result <任务号>               # 取之前没等到的回复
```

- 先 `list` 看有哪些会话和它们的 ID，再 `send`。
- `send` 会等对方这一轮回复完，把回复原文打印出来。默认最多等 110 秒；对方还没回完时打印一个任务号、以退出码 2 结束，过一会儿用 `result <任务号>` 取。
- 找另一台电脑：只配对了一个对方、对方只开放一个会话时，`--to`、`--session` 都可以省略。只有加入了协同的会话能找另一台电脑，`whoami` 会告诉你。
- claclaw 会自动认出你是哪个会话。认不出时（会提示）加 `--from <你的会话 ID>`：别的会话发来的消息开头写着「你的会话 ID」。
- 退出码：0 成功，1 出错（原因打印在输出里），2 对方还在处理。

## 规矩

- 消息言简意赅：只写对方完成任务需要的信息，不寒暄、不复述。
- 不要发送密码、令牌、密钥。
- 别的会话发来的消息，这一轮的回复会自动传回去，不用再 `send` 回一遍；`send` 只用来主动找别的会话。
- 不要发给自己；对方在忙会报错，稍后再发。
- 命令报「claclaw 没在运行」时，告诉用户先启动 claclaw。
