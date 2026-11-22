---
name: claw-file
description: 在 claclaw 网页（手机）里把文件交给用户看：图片、视频、音频、PDF、Markdown、文本 / 代码。用户说「发给我 / 给我看看 / 发个视频、截图、文档 / 我要下载」，或你做出了一个文件要交给用户时使用。
---

# claclaw 里给用户看文件

用户多半在手机上，看不到电脑屏幕。要给他看的文件，按下面两种方式交出去。

## 1. send_file 工具（首选，Claude 会话有）

工具名 `send_file`（有的列表里叫 `mcp__claclaw__send_file`），参数：`path` 文件路径（完整或相对当前目录），`name` 可选、给用户看的文件名。单个文件最多 50MB。电脑上那份会复制一份，按「设置」里的保留天数保存。一次发多个文件用 `paths`（路径数组，最多 20 个）代替 `path`；几张图片一起发会合成一组叠放卡片（点「展开」看全部），别一张调一次。

聊天里按扩展名显示成：

| 类型 | 扩展名 | 显示 |
| --- | --- | --- |
| 图片 | png jpg jpeg gif webp | 直接显示缩略图，点开看大图、可保存 |
| 矢量图 | svg | 直接显示（当图片，脚本不执行） |
| 视频 | mp4 webm mov m4v | 直接显示播放器 |
| 音频 | mp3 wav m4a ogg oga aac opus flac | 直接显示播放器 |
| Markdown | md markdown | 下载卡片，点开排好版显示，可切「源码」 |
| 文本 / 代码 | txt log json csv tsv yaml yml toml ini conf cfg env js mjs ts py sh sql html css xml | 下载卡片，点开按纯文本显示（超过 3MB 只能下载） |
| PDF、heic | pdf heic | 下载卡片，点开预览 |
| 其他 | zip、docx、xlsx… | 只有下载卡片 |

- 视频要在 iPhone 上能播：H.264 + AAC、`yuv420p`、`-movflags +faststart` 的 mp4 最稳；HEVC 的 mov 在非苹果设备上可能放不了。
  例：`ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart out.mp4`
- html / svg / xml 为安全一律当下载给（svg 例外：聊天里会作为图片显示）。
- 不要只在回复里贴路径代替发送：用户要「发给我」，就用 send_file。
- 要上网找视频、歌、电影、图片：分别用 claw-video、claw-music（纯音频）/ claw-audio（MV）、claw-movie、claw-image 技能。

## 2. 在回复里写文件路径（所有 Claw 都行）

把路径写在反引号里，例如 `` `/Users/me/out/report.md` `` 或 `` `src/app.js:120` ``（行号、`#L5` 会自动去掉；相对路径先按会话目录找）。用户点它：

- 在电脑本机打开的网页：用电脑上的默认 App 打开（可执行的文件只在访达 / 资源管理器里选中）。
- 手机等其他设备：读回来在页面里预览，支持上表里的 Markdown、文本 / 代码、图片、svg、PDF、heic；**视频、音频点路径看不了**，要用 send_file 发。文件夹看不了，超过 50MB 看不了。

没有 send_file 工具的 Claw（DeepSeek、OpenCode、Kimi、Qwen、Codex、OpenClaw、GLM、iFlow、MiniMax、CodeBuddy、Qoder、Copilot 等）只能用这种方式：做成上面能预览的格式，路径写进反引号。

## 3. 在线视频 / 音频：直接写链接

回复里出现 B 站、YouTube、Dailymotion、Vimeo、Internet Archive、SoundCloud 的播放页链接，或 mp4 / m3u8 / mp3 / m4a 等媒体直链时，claclaw 在这条消息下面放一个播放卡片，点一下在会话里直接播放（原站画质，不用下载）。写成 `[标题](网址)`，卡片上会显示标题。

能播的链接在正文里带 ▶，点了不跳出 claclaw，在聊天顶上的播放器里播（上一个 / 下一个 / 收起 / 关闭；同一条消息里所有能播的链接就是播放列表）。一条消息里能播的链接超过 3 个（片单、歌单）时不放卡片，只放一条「从第 1 个开始播」——这种列表用表格或编号列表写，每行一个 `[标题](网址)`。

## 不要依赖的

- Markdown 图片 `![说明](地址)`：只有本站地址（`/` 开头）会自动加载，外链只显示成链接；本地文件路径不会显示成图。要给图片就用 send_file。
