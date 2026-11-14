// claclaw 内置的 clarelay 电脑端（代码在 clarelay/，从 clarelay 仓库同步，见 tools/sync-clarelay.mjs）。
// - 宿主页「网络 › clarelay」粘贴设备邀请码加入；之后每次启动按身份文件自动连上（没撤销、没点「断开」）。
// - 身份文件沿用单独安装时的 ~/.clarelay-device.json：以前单独装过电脑端的电脑不用重新邀请。
// - 防两份同时跑：内置的启动前先停掉单独安装的那份（macOS launchd com.clarelay.device / Windows「启动」里的 clarelay-device.vbs），
//   内置的连上了再去掉它的开机自启；内置的没起来就把它恢复原样。
// - 断开：只停连接，身份保留，点「连接」恢复；移除：停连接并删掉身份文件，再加入要新的邀请码（中继那边显示离线，要在管理页撤销）。
// 用别的数据目录（CLACLAW_DATA，测试实例）时身份文件放在那个目录里，也不去动单独安装的那份，免得测试实例抢走本机的身份。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';

const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';
const PLIST = () => path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.clarelay.device.plist');
const STARTUP_VBS = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'clarelay-device.vbs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 设备列表里显示的名字：macOS 用「电脑名称」（os.hostname() 常常是 192.168.x.x 这种 DHCP 名），别的系统用主机名
function deviceName() {
  if (IS_MAC) { try { const n = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 3000 }).trim(); if (n) return n; } catch {} }
  if (IS_WIN && process.env.COMPUTERNAME) return process.env.COMPUTERNAME;
  return os.hostname();
}

export function relayStatePath(DATA) {
  if (process.env.CLACLAW_CLARELAY_STATE) return process.env.CLACLAW_CLARELAY_STATE;
  return process.env.CLACLAW_DATA ? path.join(DATA, 'clarelay-device.json') : path.join(os.homedir(), '.clarelay-device.json');
}

// 单独安装的电脑端开着的本机接口（127.0.0.1:8792，令牌在 .local.json）还在不在回话
function externalAlive(localFile) {
  let lt; try { lt = JSON.parse(fs.readFileSync(localFile, 'utf8')); } catch { return Promise.resolve(false); }
  let u; try { u = new URL(lt.url); } catch { return Promise.resolve(false); }
  return new Promise(ok => {
    const r = http.get({ host: '127.0.0.1', port: Number(u.port) || 8792, path: '/status', headers: { authorization: 'Bearer ' + lt.token }, timeout: 1500 }, res => { res.resume(); ok(res.statusCode === 200); });
    r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); });
  });
}

/**
 * @param {object} o
 * @param {number} o.port    claclaw 的本机端口（电脑端把请求转到 http://127.0.0.1:port）
 * @param {string} o.DATA
 * @param {() => boolean} o.getOff     用户点了「断开」
 * @param {(off: boolean) => void} o.setOff
 * @param {(dev: object|null) => void} o.onDevice  内置的起来 / 停了（devnotify 改成直接调它）
 * @param {(...a) => void} o.log
 * @param {() => Promise<object>} [o.load]  测试用：替换 import('./clarelay/agent.mjs')
 */
export function makeRelayDev(o) {
  const STATE = relayStatePath(o.DATA), LOCAL = STATE.replace(/\.json$/, '') + '.local.json';
  const isolated = STATE !== path.join(os.homedir(), '.clarelay-device.json') && !process.env.CLACLAW_CLARELAY_STATE;
  const log = (...a) => o.log('clarelay', ...a);
  let dev = null, starting = null, lastErr = '';
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };

  // 停掉单独安装的那份；返回 { found, commit()（内置的起来了：去掉它的自启）, restore()（内置的没起来：恢复原样） }
  async function stopExternal() {
    const none = { found: false, commit() {}, restore() {} };
    if (isolated) return none;
    if (IS_MAC && fs.existsSync(PLIST())) {
      const uid = process.getuid();
      try { execFileSync('launchctl', ['bootout', 'gui/' + uid + '/com.clarelay.device'], { stdio: 'ignore' }); } catch {}
      log('停掉单独安装的电脑端（launchd com.clarelay.device）');
      const restore = () => { try { execFileSync('launchctl', ['bootstrap', 'gui/' + uid, PLIST()], { stdio: 'ignore' }); log('已恢复单独安装的电脑端'); } catch (e) { log('恢复单独安装的电脑端失败：', e.message); } };
      for (let i = 0; i < 10 && await externalAlive(LOCAL); i++) await sleep(500);
      if (await externalAlive(LOCAL)) { restore(); throw new Error('本机还有一个单独运行的 clarelay 电脑端停不掉（127.0.0.1:8792 还在回话），先手动停掉它'); }
      return { found: true, restore, commit() { try { fs.unlinkSync(PLIST()); } catch {} try { fs.unlinkSync(LOCAL); } catch {} log('已去掉单独安装的电脑端的开机自启（身份文件保留）'); } };
    }
    if (IS_WIN && (fs.existsSync(STARTUP_VBS()) || await externalAlive(LOCAL))) {
      const vbs = STARTUP_VBS(), bak = vbs + '.claclaw-bak', had = fs.existsSync(vbs);
      if (had) fs.renameSync(vbs, bak);
      let port = 8792; try { port = Number(new URL(JSON.parse(fs.readFileSync(LOCAL, 'utf8')).url).port) || 8792; } catch {}
      // 守护脚本 wscript（命令行里有 clarelay-device.vbs）、它起的 node（命令行里有 device\agent.mjs）、占着本机接口端口的进程；不碰自己
      const ps = `$ids = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*clarelay-device.vbs*') -or ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*device\\agent.mjs*' -or $_.CommandLine -like '*device/agent.mjs*')) } | ForEach-Object { $_.ProcessId })
$ids += @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
$ids | Where-Object { $_ -and $_ -ne ${process.pid} } | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
      try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true }); } catch {}
      log('停掉单独安装的电脑端（clarelay-device.vbs）');
      const restore = () => {
        try { if (had) { fs.renameSync(bak, vbs); spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); log('已恢复单独安装的电脑端'); } }
        catch (e) { log('恢复单独安装的电脑端失败：', e.message); }
      };
      for (let i = 0; i < 10 && await externalAlive(LOCAL); i++) await sleep(500);
      if (await externalAlive(LOCAL)) { restore(); throw new Error('本机还有一个单独运行的 clarelay 电脑端停不掉（本机接口还在回话），先手动停掉它'); }
      return { found: true, restore, commit() { try { fs.unlinkSync(bak); } catch {} try { fs.unlinkSync(LOCAL); } catch {} log('已去掉单独安装的电脑端的开机自启（身份文件保留）'); } };
    }
    // 没装自启、但手动开着一份：不替它做主，提示先停掉
    if (await externalAlive(LOCAL)) throw new Error('本机还有一个单独运行的 clarelay 电脑端（127.0.0.1:8792），先停掉它再用内置的');
    return none;
  }

  function start(invite) {
    if (dev && !invite) return Promise.resolve(info());
    if (starting) return starting;
    starting = (async () => {
      lastErr = '';
      if (dev) { await dev.stop(); dev = null; o.onDevice(null); }   // 被撤销后用新邀请码重新加入
      const ext = await stopExternal();
      try {
        const { startDevice } = await (o.load ? o.load() : import('./clarelay/agent.mjs'));
        const d = await startDevice({ invite: invite || undefined, state: STATE, name: deviceName(), services: { claclaw: 'http://127.0.0.1:' + o.port }, log,
          onStatus: s => { if (s.error) lastErr = s.error; else if (s.online) lastErr = ''; } });   // 每次连不上都带原因；连上（hello）不带 error，清掉
        dev = d; o.onDevice(d); ext.commit();
        log('内置电脑端已启动：' + d.url);
      } catch (e) { lastErr = e.message; ext.restore(); throw e; }
      return info();
    })().finally(() => { starting = null; });
    return starting;
  }

  async function stop() {
    if (starting) { try { await starting; } catch {} }
    if (!dev) return;
    const d = dev; dev = null; o.onDevice(null);
    await d.stop();
    log('内置电脑端已停止');
  }

  function info() {
    const st = readState();
    const url = dev?.url || (st?.label && st?.domain ? 'https://' + st.label + '.' + st.domain + (st.port && st.port !== 443 ? ':' + st.port : '') : '');
    return {
      joined: !!st?.id, off: !!o.getOff(), running: !!dev, starting: !!starting,
      name: dev?.name || st?.name || '', url, shellUrl: dev?.shellUrl || '',
      online: !!dev?.online, status: dev?.status || st?.status || null, revoked: !!st?.revoked || dev?.status === 'revoked',
      cert: dev ? !!dev.cert?.ok : null, error: lastErr,
    };
  }

  return {
    info,
    // claclaw 启动、主端口占到之后调：有身份、没撤销、没断开就直接连
    autoStart() {
      const st = readState();
      if (!st?.id || st.revoked || o.getOff()) return;
      start().catch(e => log('内置电脑端没起来：', e.message));
    },
    async join(invite) {
      // 邀请码：clarelay 复制出来的 JSON（可带换行），或旧的一行 clarelay-device1.…；格式由 clarelay/common.mjs 的 parseDeviceInvite 认
      const v = String(invite || '').trim();
      if (v.startsWith('{')) { try { JSON.parse(v); } catch { throw new Error('邀请码不是完整的 JSON：从 clarelay 复制时要整段复制'); } }
      else if (!/clarelay-device1\./.test(v)) throw new Error('这不是 clarelay 设备邀请码');
      o.setOff(false);
      return start(v);
    },
    async connect() { if (!readState()?.id) throw new Error('还没加入：先粘贴设备邀请码'); o.setOff(false); return start(); },
    async disconnect() { o.setOff(true); await stop(); return info(); },
    async remove() { await stop(); try { fs.unlinkSync(STATE); } catch {} o.setOff(false); lastErr = ''; log('已移除本机身份文件'); return info(); },
    stop,
  };
}
