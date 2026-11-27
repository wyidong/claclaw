// Windows：登录后自动在后台启动 claclaw。macOS 有 launchd；Windows 原来要自己开窗口 npm start，
// 关机再开机后服务没起来，桌面上的 claclaw（只是网页的快捷方式 / PWA）就打不开，不懂技术的用户不知道怎么办。
// 所以 claclaw 在 Windows 上第一次跑起来时，自动在「启动」文件夹里放一个 claclaw.vbs：
//   - 登录后不弹窗口，用 node 跑 tools\win-serve.mjs（挂了自动拉起，输出进 %LOCALAPPDATA%\claclaw\Logs\server.log）
//   - 只自动放一次（data/win-autostart.json 记着）：用户删了这个文件就是不要开机启动，以后不再放回；
//     设了 CLACLAW_AUTOSTART=0 不放；用 CLACLAW_DATA 指定了别的数据目录（测试、多开）也不放
//   - 放过、文件还在：node 位置、端口、监听地址变了就更新内容；指向的是另一份还在的 claclaw（worktree）不抢，那份没了才改指这里
//   - 以后：VBScript 微软在逐步淘汰（将来的 Windows 默认关掉），到时换成「登录时运行」的计划任务或隐藏窗口的快捷方式
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const startupDir = (env = process.env) =>
  path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

const vq = s => '"' + String(s).replace(/"/g, '""') + '"';   // VBScript 字符串

// claclaw.vbs 的内容。端口不是默认的就带 --port；监听地址照原样带上（计划任务、开机启动都不继承当时的环境变量）
export function vbsText({ root, node, port = 8787, host = '' }) {
  const cmd = '"' + node + '" tools\\win-serve.mjs' + (port && Number(port) !== 8787 ? ' --port ' + Number(port) : '');
  return [
    "' claclaw：登录 Windows 后在后台启动（claclaw 自动放的；不想开机启动就删掉这个文件）",
    "' 挂了会自动拉起；输出在 %LOCALAPPDATA%\\claclaw\\Logs\\server.log",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = ' + vq(root),
    ...(host ? ['sh.Environment("PROCESS")("CLACLAW_HOST") = ' + vq(host)] : []),
    'sh.Run ' + vq(cmd) + ', 0, False',
    '',
  ].join('\r\n');
}

// 返回做了什么：'created' | 'updated' | 'ok' | 'skip:<原因>'
export function ensureAutostart({ root, data, port, host = '', node = process.execPath, env = process.env, platform = process.platform, dir = startupDir(env), log = () => {} }) {
  if (platform !== 'win32') return 'skip:not-windows';
  if (env.CLACLAW_AUTOSTART === '0') return 'skip:off';
  if (env.CLACLAW_DATA) return 'skip:custom-data';
  const file = path.join(dir, 'claclaw.vbs'), mark = path.join(data, 'win-autostart.json');
  const text = vbsText({ root, node, port, host });
  // UTF-16 带 BOM：WSH 按这个读，安装路径里有中文也不乱
  const write = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, Buffer.from('﻿' + text, 'utf16le')); };
  try {
    if (fs.existsSync(file)) {
      let old = ''; try { old = fs.readFileSync(file).toString('utf16le').replace(/^﻿/, ''); } catch {}
      if (old === text) return 'ok';
      // 指向的是另一份还在的 claclaw（开发时在 worktree 里另起一份）：不抢，开机启动的还是原来那份；那份没了才改指这里
      const was = (old.match(/^sh\.CurrentDirectory = "((?:[^"]|"")*)"/m) || [])[1]?.replace(/""/g, '"');
      if (was && path.resolve(was).toLowerCase() !== path.resolve(root).toLowerCase() && fs.existsSync(path.join(was, 'server.mjs'))) return 'skip:other-root';
      write(); log('开机启动已更新：' + file); return 'updated';
    }
    if (fs.existsSync(mark)) return 'skip:removed-by-user';
    write();
    fs.writeFileSync(mark, JSON.stringify({ file, at: new Date().toISOString() }) + '\n');
    log('已设好开机启动：登录 Windows 后在后台自动启动 claclaw（' + file + '；不要的话删掉这个文件）');
    return 'created';
  } catch (e) { log('开机启动没设好：' + e.message); return 'skip:error'; }
}
