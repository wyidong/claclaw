---
name: claw-video
description: 找视频给用户看：用户说「找 / 发一段讲 XX 的视频」「来个 XX 的短视频」「有没有 XX 的教程 / 纪录片片段」「再来几个类似的」「把这个视频链接下下来发我」时使用。给能在 claclaw 聊天里直接播的视频链接（B 站、YouTube 等原站画质），要文件时下载成 mp4。电影用 claw-movie，歌和音频用 claw-audio，电视直播用 claw-tv。
---

# 找视频

从 B 站、YouTube、Dailymotion、Internet Archive 并发搜，只给**能嵌在 claclaw 聊天里直接播**的链接，不下载、不转码，通常 2～3 秒。**只用这个命令，不要自己编链接。** 不先问用户细节，按默认值直接做，发完再问要不要换。

## 命令

```sh
~/.claclaw/bin/claw-video "关键词" [--n 1] [--max 秒]        # 能直接播的链接，默认 30 分钟以内
~/.claclaw/bin/claw-video find "关键词" [--n 10]              # 候选列表（用户要「换一个」时）
~/.claclaw/bin/claw-video get "关键词或网址" [--pick 序号]    # 下载成 mp4（用户要文件 / 离线看时）
~/.claclaw/bin/claw-video related "B 站 / YouTube 视频网址"   # 相关视频（「类似的」「还有吗」）
~/.claclaw/bin/claw-video sources                             # 各来源成败、耗时
```

Windows 用 `%USERPROFILE%\.claclaw\bin\claw-video.cmd`；没有这个命令时用 `node <claclaw 仓库>/skills/claw-video/video.mjs`。

常用参数：`--max 300` 只要 5 分钟以内（「短视频」）；`--n 3` 给几个（最多 5）；`--src bili,youtube` 只用这些来源；下载时 `--clip 60` 只要开头 60 秒、`--max-mb 45` 大小上限（超了自动降清晰度）。

## 怎么回复

- 默认命令每行是 `[标题](网址)  来源  时长  播放量`。**把 `[标题](网址)` 原样写进回复**，前面一两句说来源、时长、为什么选它。claclaw 会在下面放播放卡片，点了在聊天里播。
- 一次给 1 个；用户要「几个 / 一个系列」时 `--n 3`。
- 「换一个」：`find` 看列表，挑一个把网址写成 `[标题](网址)`；或 `--src` 换来源。
- 「类似的 / 相关的」：`related` 原视频网址，挑 3～5 个写成编号列表 `1. [标题](网址) · 时长`。
- 下载：`get` 每行是 `文件路径  大小  来源  时长  标题  出处`。Claude 用 `send_file` 发文件；没有 `send_file` 的 Claw 在回复里用反引号写出路径，并告诉用户视频要在电脑上放。

## 关键词怎么写

- 「讲西游故事的短视频」→ `"西游记 故事" --max 300`；儿童向加「动画 / 儿童」，要片段写具体情节（「三打白骨精」）。
- 外文内容用英文关键词，能搜到更多 YouTube 结果。

## 说明

- B 站、国内来源直连；YouTube、Dailymotion、Internet Archive 要出墙，自动用环境变量里的代理或本机 7890 / 7897 端口，没有代理就跳过。
- 下载靠 yt-dlp 和 ffmpeg（没有会自动下到 `~/.claclaw/tools/`），转成手机能放的 H.264 mp4。下载失败（下架、地区限制、防盗链）自动换下一个。
- 只给个人观看，不下载付费、会员、DRM 内容，不绕过登录或地区限制。
