---
name: claw-install
description: 在这台电脑上安装 Agent：用户说「帮我装 DeepSeek」「装一下 DeepSeek Harness / dsh」「DeepSeek 装好了吗」时使用。现在只能装 DeepSeek Harness；开始装之前 claclaw 会让用户在网页上点确认，装的过程在 Claw 页的卡片上看进度。别的软件装不了。
---

# 安装 Agent

kuAi 自己不能装软件。这个技能是请 claclaw 去装——只能装 claclaw 列出来的（现在只有 DeepSeek Harness），不能装别的包。

## 命令

```sh
~/.claclaw/bin/claw-install deepseek   # 开始装 DeepSeek Harness（已经装了、正在装的会说明，不会重复装）
~/.claclaw/bin/claw-install status     # 看装到哪了
```

- 开始装之前用户要在网页上点「允许」；没点就不装，照实告诉用户。
- 安装一般要 1–5 分钟。命令不会等到装完：它报一次进度就返回，之后用户在 Claw 页 DeepSeek 那张卡片上看进度，或者再问你时用 `status` 查。
- 别的软件（Python、Homebrew、别的 Agent……）这里装不了：给出安装命令，让用户自己在电脑的终端里跑。

## 怎么回复

把命令的输出用一两句话照实转告用户，不要说成已经装好（除非输出里写了「装好了」）。输出里提到「填 API Key」的那句要带上：装好以后不填 key 用不了。
