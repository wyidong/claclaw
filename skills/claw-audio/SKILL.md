---
name: claw-audio
description: 找歌和音频给用户听：用户说「来首 XX 的歌」「放一首周杰伦的晴天」「我想听 XX」「来段雨声 / 白噪音 / 轻音乐」「找个 XX 的有声书 / 相声」「XX 的 MV」「把这首歌下下来」时使用。给能在 claclaw 聊天里直接播的链接（B 站、YouTube、SoundCloud 等），要文件时下载成 m4a。普通视频用 claw-video，电影用 claw-movie。
---

# 找歌、找音频

从 B 站、YouTube、SoundCloud、Internet Archive、Openverse 并发搜，只给**能嵌在 claclaw 聊天里直接播**的链接，通常 2～3 秒。**只用这个命令，不要自己编链接。** 不先问用户细节，直接给，发完再问要不要换版本。

## 命令

```sh
~/.claclaw/bin/claw-audio "歌名 歌手" [--n 1] [--max 秒]   # 能直接播的链接，默认 60 分钟以内
~/.claclaw/bin/claw-audio find "关键词" [--n 10]            # 候选列表（「换个版本」时）
~/.claclaw/bin/claw-audio get "关键词或网址" [--pick 序号]  # 下载成 m4a（用户要文件时）
~/.claclaw/bin/claw-audio sources                           # 各来源成败、耗时
```

Windows 用 `%USERPROFILE%\.claclaw\bin\claw-audio.cmd`；没有这个命令时用 `node <claclaw 仓库>/skills/claw-audio/audio.mjs`。

## 怎么回复

- 每行是 `[标题](网址)  来源  时长  播放量`。**把 `[标题](网址)` 原样写进回复**，前面一句说是谁唱的、哪个版本。claclaw 会放播放卡片，点了在聊天里播。
- 一次给 1 首；用户要「几首 / 歌单」时 `--n 5`，写成编号列表 `1. [歌名](网址) · 时长 · 来源`，超过 3 首时 claclaw 会把它当播放列表连着放。
- 「换个版本 / 要现场版」：`find` 看列表挑一个，或关键词加「现场 / live / 伴奏 / 钢琴版」再搜。
- 下载：`get` 每行是 `文件路径  大小  来源  时长  标题  出处`。Claude 用 `send_file` 发文件；没有 `send_file` 的 Claw 在回复里用反引号写出路径。

## 关键词怎么写

- 歌：`"歌名 歌手"`，比如 `"晴天 周杰伦"`；只说歌手时用 `"周杰伦 热门歌曲" --n 5`。
- 要 MV、要原版：加「MV」「官方」。
- 白噪音、轻音乐、外文歌用英文关键词结果更多（「rain sound」「lofi」）。

## 说明

- 没有接入 QQ 音乐、网易云这类要登录、有版权保护的平台，结果多是官方频道和用户上传的公开视频的音轨。找不到正版时如实说。
- YouTube、SoundCloud、Internet Archive、Openverse 要出墙，自动用代理（环境变量或本机 7890 / 7897），没有代理就只搜 B 站。
- Openverse 的音频是 CC 授权的，要公开使用时优先选它，并告诉用户出处。
- 只给个人收听，不下载付费、会员、DRM 内容。
