---
name: claclaw-media
description: 上网找视频、音频、图片发给用户：多个来源（B 站、YouTube、Dailymotion、SoundCloud、Internet Archive、Openverse、Bing / 百度 / 360 图片、Wikimedia Commons）并发检索，挑最合适的下载成手机能直接放、直接看的文件，再发到 claclaw 聊天里。用户说「找 / 发一段讲 XX 的视频」「来首 XX 的歌 / 一段 XX 的音频」「发几张 XX 的图片」「把这个链接下下来发我」时使用。
---

# 找视频、音频、图片发给用户

目标是快：一条命令搜索、挑选、下载，通常 10～20 秒完成。不要先问用户细节，按默认值直接做，发完再问要不要换。

## 一条命令拿到文件（首选）

```sh
~/.claclaw/bin/claclaw-media get video "关键词"            # 一段视频（默认 10 分钟以内）
~/.claclaw/bin/claclaw-media get audio "关键词"            # 一段音频（默认 30 分钟以内）
~/.claclaw/bin/claclaw-media get image "关键词" --n 3      # 几张图片
~/.claclaw/bin/claclaw-media get video|audio|image <网址>   # 用户给了链接：直接下这个
```

（Windows 是 `%USERPROFILE%\.claclaw\bin\claclaw-media.cmd`；没有这个命令时用 `node <claclaw 仓库>/skills/claclaw-media/media.mjs`。）

stdout 每行一个结果，制表符分隔：`文件路径  大小  来源  时长  标题  出处网址`。拿到路径后：

- **Claude 会话**：用 `send_file` 工具发出文件。视频、音频在聊天里直接显示播放器，图片直接显示。
- **没有 send_file 的 Claw**：在回复里用反引号写出文件路径。图片手机上点开能看，视频、音频只能在电脑上放，要告诉用户。
- 回复一两句：标题、时长、来源和出处网址。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--max 300` | 只要 300 秒以内的（「短视频」用 300） |
| `--clip 60` | 只要开头 60 秒（只下这一段，快、文件小） |
| `--n 3` | 图片张数 |
| `--src bili,youtube` | 只用这些来源 |
| `--max-mb 45` | 视频大小上限，超了自动降清晰度或压缩（send_file 上限 50MB） |

## 先看候选再挑

```sh
~/.claclaw/bin/claclaw-media find video "关键词" [--n 10] [--max 秒]
~/.claclaw/bin/claclaw-media get video "同一个关键词" --pick 3      # 下列表里第 3 个（列表缓存 30 分钟）
~/.claclaw/bin/claclaw-media sources                                 # 各来源成败、耗时、是否可用
```

用户要「换一个」「要别的来源的」时用 `find` 看列表，再 `--pick`；或 `--src` 换来源。

## 关键词怎么写

- 用户说「讲西游故事的短视频」→ `get video "西游记 故事" --max 300`；儿童向加「动画 / 儿童 / 绘本」，要片段写具体情节（「三打白骨精」）。
- 音乐、白噪音、外文内容用英文关键词能搜到 YouTube、SoundCloud、Openverse 的更多结果（「rain sound」「lofi」）。
- 中文关键词国内来源（B 站、百度、360、Bing）会略微优先，下载也更稳。

## 机制（为什么快、为什么稳）

1. **多来源**：每类都有国内直连的和要出墙的来源；要出墙的自动用环境变量里的代理或本机 7890 / 7897 端口，没有代理就跳过。
2. **并发、限时**：同类所有来源一起搜，最多等 10 秒；过了 3 秒、六成来源回来了、结果够了，就不再等慢的。
3. **打分 + 多样性**：标题贴题、来源内排名、播放量、国内来源加分；合集、长直播、小图扣分。同一来源连续入选会扣分，所以结果里各来源都有。
4. **自动换**：下载失败（下架、地区限制、DRM、防盗链）自动换下一个，视频 / 音频最多试 4 个；图片原图下不来就用搜索引擎的缩略图。
5. **健康记录**：每个来源的成败和耗时记在 `~/.claclaw/media/health.json`，连续失败 3 次的冷却 30 分钟。
6. **格式**：视频转成 H.264 + AAC 的 mp4（720p 以内，按大小上限自动选清晰度）；音频转成 m4a；图片只留 jpg / png / gif / webp。手机都能直接放、直接看。

工具：视频、音频靠 yt-dlp（没有会自动下到 `~/.claclaw/tools/`），B 站和截取片段要 ffmpeg。

## 加来源

来源都在同目录的 `sources.mjs`，每个来源一项：`{ id, kinds: ['video'|'audio'|'image'], proxy, search(q, ctx) }`，`search` 返回 `[{ title, page 或 file, thumb?, dur?, plays?, w?, h? }]`。只写「怎么搜」，并发、超时、排序、去重、下载、失败降级都由引擎负责。

## 注意

- 只给用户个人观看 / 收听。不下载付费、会员、DRM 内容，不绕过登录或地区限制。
- Openverse 的音频和图片是 CC 授权的，要拿来公开使用时优先选它和 Wikimedia Commons，并告诉用户出处。
- 下载的文件在系统临时目录的 `claclaw-media/` 下，发完不用留。
