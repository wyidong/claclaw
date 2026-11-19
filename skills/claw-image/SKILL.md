---
name: claw-image
description: 找图片发给用户：用户说「发几张 XX 的图片」「找张 XX 的照片 / 壁纸」「XX 长什么样，给我看看」「要一张能公开用的 XX 图」时使用。从 Bing、百度、360、Wikimedia Commons、Openverse 并发搜，下载后发文件，聊天里直接显示。
---

# 找图片

多个图片来源并发搜，下载原图（下不来用缩略图），通常几秒。**只用这个命令，不要自己编图片地址。** 不先问细节，默认 3 张，发完再问要不要换。

## 命令

```sh
~/.claclaw/bin/claw-image "关键词" [--n 3]      # 下载图片
~/.claclaw/bin/claw-image find "关键词" [--n 10]  # 候选列表；再 "同一个关键词" --pick 序号 下载那一张
~/.claclaw/bin/claw-image sources               # 各来源成败、耗时
```

Windows 用 `%USERPROFILE%\.claclaw\bin\claw-image.cmd`；没有这个命令时用 `node <claclaw 仓库>/skills/claw-image/image.mjs`。

`--src commons,openverse` 只要能公开使用的（CC 授权 / 公版）。

## 怎么回复

- 每行一张，制表符分隔，第一列是文件路径，后面是大小、来源、标题、出处网址。
- **Claude 用 `send_file` 把每张图发出去**，聊天里直接显示。没有 `send_file` 的 Claw 在回复里用反引号写出文件路径，手机上点开能看。
- 文字只写一两句（来源、要不要换），不要把出处网址整串贴出来，除非用户要公开使用。

## 说明

- Bing、百度、360 国内直连；Openverse 要出墙。Wikimedia Commons 和 Openverse 的图是 CC 授权或公版，要公开使用时用 `--src commons,openverse`，并告诉用户出处和授权。
- 搜索引擎的图来自各网站，版权归原作者，只给个人查看。
- 下载的文件在系统临时目录的 `claclaw-media/` 下，发完不用留。
