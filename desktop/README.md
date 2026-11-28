# claclaw 桌面版（安装包）

给不懂技术的用户：下载安装包双击就装好，不用自己装 Node、Git，不用敲命令。

## 装好以后是什么样

- 装在当前用户目录，不要管理员权限；桌面和开始菜单有 claclaw 图标。
- 打开后在托盘（任务栏右下角）常驻，claclaw 服务在后台跑，挂了自动拉起；第一次打开会在浏览器里打开 claclaw 网页（http://127.0.0.1:8787），按提示建账号。
- 托盘菜单：打开 claclaw、开机自动启动（第一次装好默认打开）、重启 claclaw 服务、查看日志、退出。
- 再点桌面图标 = 打开 claclaw 网页（只会有一个在跑）。
- 数据在 `%APPDATA%\claclaw\data`（macOS：`~/Library/Application Support/claclaw/data`），日志在同级的 `logs\`；卸载、更新都不删数据。
- 这台电脑上已经有一份 claclaw 在 8787 跑着（比如以前用脚本装的）：桌面版不另起，直接用那份；那份停了再自己接手。
- 以前用脚本装过、建过账号（Windows：「启动」里 claclaw.vbs 指向的目录，或 `%USERPROFILE%\claclaw`，里面有 `data\auth.json`）：桌面版直接用那份数据，账号、会话、设置都在，不会冒出一个没账号的新实例。
- 装各家 Claw 用自带的 npm；用户自己没设 `npm_config_registry` 时用国内镜像 registry.npmmirror.com。
- 卸载时删掉开机自动启动项（更新安装不删）。

claclaw 只管这台电脑上的事；手机等别的设备怎么连进来是 clarelay 的事，安装包里不做。

## 怎么打包

要在目标系统上打（依赖里的 Claude Code、node-datachannel 分平台，npm 只装本机平台那份）。

```
cd desktop
npm install
npm run dist:win      # Windows：dist/out/claclaw-setup-<版本>-win-x64.exe
npm run dist:mac      # macOS：dmg（还没签名）
```

`npm run stage`（build.mjs）先备料到 `dist/stage/`：官方 Node 运行时（下载后按 SHASUMS256 校验，去掉头文件和 corepack）+ 仓库里受版本管理的程序文件 + `npm ci --omit=dev` 装好的依赖，再给依赖和 npm 瘦身（删文档、类型声明、source map、测试目录，文件数少一半，装得快）。electron-builder 不肯把 extraResources 里的 node_modules 打进去，由 `afterPack.cjs` 补上。

国内网络：`CLACLAW_NODE_MIRROR=https://npmmirror.com/mirrors/node`、`npm_config_registry=https://registry.npmmirror.com`、`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 和 claclaw 本体的约定

- 服务用自带的 node 跑：`resources/node/node.exe server.mjs`，PATH 最前面是自带的 node、npm（装各家 Claw 要用）。
- 环境变量 `CLACLAW_APP_DATA`：数据目录（不用 `CLACLAW_DATA`，那个在别处当「测试实例」）。
- 环境变量 `CLACLAW_SUPERVISOR=desktop`：claclaw 自己重启（`npm run restart` / tools/restart-when-idle.mjs）时只结束 server，由桌面程序拉起；Windows 也不再往「启动」文件夹放 claclaw.vbs（开机启动由桌面程序管）。

## 测试时

`CLACLAW_PORT=8799`（换端口）、`CLACLAW_DESKTOP_USER_DIR=<临时目录>`（数据、日志放别处）、`CLACLAW_DESKTOP_NO_AUTOSTART=1`（不碰系统开机启动项），再带 `--hidden` 不打开浏览器。

## 还没做

自动更新（electron-updater + 国内 CDN）、代码签名（没签名时 Windows 会提示「已保护你的电脑」，要点「更多信息 → 仍要运行」）。
