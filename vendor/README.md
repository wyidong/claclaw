# vendor：第三方库

claclaw 运行时用到、但不属于 claclaw 的代码放在这里。它们在运行时下载，**不进 claclaw 版本库**：这个目录只提交本说明和 `.gitignore`。

由 `vendor.mjs` 管理：

- 每个库在 `vendor.mjs` 的 `LIBS` 里登记：清单路径、文件路径、哪些文件必须有。
- 下载：先读清单 `{ version, files: { 文件名: sha256 } }`，再逐个下载、核对 sha256。全部对上才写成新的版本目录 `vendor/<库>/<版本>-<哈希前 8 位>/`，然后把 `vendor/<库>/current.json` 指过去。
- 只从 https 下载：按系统 CA 校验证书，不跟跳转。本机回环地址可以用 http，只给测试用。
- sha256 只防下载不完整，不防下载地址本身被人改了。所以只从用户自己信得过的地址下载。
- 已经加载进内存的旧版本照常运行；换新版的地方重新 import 新目录。保留当前和上一个版本，更早的删掉。
- 命令行：`node tools/vendor.mjs` 列出已装的库；`node tools/vendor.mjs install <库> <https://下载地址>` 安装或更新；`--src <目录>` 从本机目录装（开发用）。

## 现有的库

| 库 | 用途 | 从哪下载 |
|---|---|---|
| clarelay | 内置 clarelay 电脑端（relaydev.mjs）和协同中继隧道（tunnel.mjs） | 加入的那台 clarelay 中继主域名 `/_relay/client/`（协议见那台中继的 `/_relay/PROTOCOL.md`） |

clarelay 什么时候下载：
- 宿主页加入 clarelay 时，从邀请码里的中继下载。
- 启动时没有，就从身份文件里的中继下载。
- 宿主页有新版时会显示「更新到 x」，点了就下载并重连，不用重启 claclaw。
