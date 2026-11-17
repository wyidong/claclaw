// claclaw 内置的 clarelay 电脑端：clarelay 是可选的第三方网络渠道，用户在宿主页粘贴设备邀请码之前 claclaw 不碰它。
// 代码是第三方库（vendor.mjs）：单文件 clarelay.mjs，从加入的那台 clarelay 中继主域名下载到 vendor/clarelay/，不进 claclaw 版本库（协议见中继的 /_relay/PROTOCOL.md §17）。
// - 没下载过：加入时（按邀请码里的中继）或启动时（按身份文件里的中继）先下载，用发布公钥验签后再用；下载失败过一阵重试。
// - 发布公钥：设备邀请码里带的（k / releaseKey），按圈子域名记在数据目录，以后只认它；邀请码还没带公钥时就加入的老电脑，
//   用设备凭证连一次控制连接，读中继 hello 里的 releaseKey 记下（§9.4、§17），之后以记下的为准，不跟着中继换。
// - 有新版：宿主页显示「更新到 x」，点了下载新版、重连（不用重启 claclaw）。
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
import tls from 'node:tls';
import { execFileSync, spawn } from 'node:child_process';
import { libImport, libInstall, libFetch, libInfo, libDir, newerVersion, releaseKeyOk } from './vendor.mjs';

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

// 下载电脑端的地址：中继主域名（邀请码 / 身份文件里的 domain + port）；邀请码里还带发布公钥（紧凑格式的 k、JSON 的 releaseKey，见 clarelay PROTOCOL.md §8.1）
const hostBase = (d, p) => /^[a-z0-9.-]+$/i.test(d || '') ? 'https://' + d.toLowerCase() + (Number(p) && Number(p) !== 443 ? ':' + Number(p) : '') : '';
export function inviteInfo(v) {
  v = String(v || '').trim();
  let d, p, k;
  try {
    if (v.startsWith('{')) { const j = JSON.parse(v); d = j.relay; p = j.port; k = j.releaseKey; }
    else { const m = /clarelay-device1\.([A-Za-z0-9_-]+)/.exec(v.replace(/\s+/g, '')); if (m) { const j = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); d = j.d; p = j.p; k = j.k; } }
  } catch {}
  const base = hostBase(d, p);
  return { base, domain: base ? String(d).toLowerCase() : '', key: base ? releaseKeyOk(k) : '' };
}
export const inviteBase = v => inviteInfo(v).base;
const stateBase = st => st ? hostBase(st.domain, st.port) : '';
// 老电脑取发布公钥：用设备凭证建一次控制连接（GET /_device/control + Upgrade: clarelay，§9.1），读到中继发的 hello 就断开，
// 返回 hello.releaseKey（格式不对 / 没有返回 ''）。只在本机还没有电脑端代码时用：这时没有别的控制连接在跑（中继会断开同一设备的旧连接）
export function helloKey(st, { timeout = 20e3, connect = tls.connect } = {}) {
  return new Promise((ok, fail) => {
    if (!st?.id || !st.token || !/^[a-z0-9.-]+$/i.test(st.domain || '')) return fail(new Error('本机身份文件不完整'));
    const host = st.domain.toLowerCase(), port = Number(st.port) || 443;
    let buf = Buffer.alloc(0), head = true, done = false;
    const s = connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] });
    const end = (e, k) => { if (done) return; done = true; clearTimeout(t); s.destroy(); e ? fail(e) : ok(k); };
    const t = setTimeout(() => end(new Error('等中继的 hello 超时')), timeout);
    s.on('secureConnect', () => s.write('GET /_device/control HTTP/1.1\r\nhost: ' + host + (port !== 443 ? ':' + port : '') +
      '\r\nconnection: Upgrade\r\nupgrade: clarelay\r\nauthorization: Bearer ' + st.token + '\r\nx-device-id: ' + st.id + '\r\n\r\n'));
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 1 << 20) return end(new Error('中继的 hello 太长'));
      if (head) {
        const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
        const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, i).toString('latin1'))?.[1]);
        if (code !== 101) return end(new Error(code === 401 ? '设备凭证不对（可能已被撤销）' : '控制连接没建起来（HTTP ' + (code || '?') + '）'));
        head = false; buf = buf.subarray(i + 4);
      }
      for (let j; (j = buf.indexOf(10)) >= 0;) {
        const line = buf.subarray(0, j).toString('utf8').trim(); buf = buf.subarray(j + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m && m.t === 'hello') return end(null, releaseKeyOk(m.releaseKey));
      }
    });
    s.on('error', e => end(e));
    s.on('close', () => end(new Error('连接断了，没等到中继的 hello')));
  });
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
 * @param {() => void} [o.onLib]  电脑端代码刚下载 / 换了新版（协同中继的隧道要重新加载 clarelay.mjs）
 * @param {() => Promise<object>} [o.load]  测试用：替换加载电脑端（vendor/clarelay/…/clarelay.mjs），也不去查新版本
 * @param {(st: object) => Promise<string>} [o.helloKey]  测试用：替换「连一次控制连接取发布公钥」
 */
export function makeRelayDev(o) {
  const STATE = relayStatePath(o.DATA), LOCAL = STATE.replace(/\.json$/, '') + '.local.json';
  const isolated = STATE !== path.join(os.homedir(), '.clarelay-device.json') && !process.env.CLACLAW_CLARELAY_STATE;
  const log = (...a) => o.log('clarelay', ...a);
  let dev = null, starting = null, lastErr = '', retry = null, retryN = 0;
  let latest = null, checking = null;   // 下载地址上的最新版本 { version, at }（6 小时查一次）
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };

  // 电脑端代码：已下载就直接用；没下载就从中继下载（加入时按邀请码，之后按身份文件）
  // 发布公钥：按圈子域名记在数据目录（加入时从邀请码记下，以后只认它；邀请码带公钥之前就加入的老电脑从中继取一次）
  const KEYS = path.join(o.DATA, 'clarelay-release-keys.json');
  const readKeys = () => { try { return JSON.parse(fs.readFileSync(KEYS, 'utf8')) || {}; } catch { return {}; } };
  const keyOf = domain => releaseKeyOk(readKeys()[domain]?.key);
  function saveKey(domain, key, via) {
    const all = readKeys();
    if (!domain || !key || all[domain]?.key === key) return;
    const old = all[domain]?.key;
    all[domain] = { key, via, at: Date.now() };
    fs.writeFileSync(KEYS + '.tmp', JSON.stringify(all, null, 2), { mode: 0o600 }); fs.renameSync(KEYS + '.tmp', KEYS);
    log((old ? '换了' : '记下') + ' ' + domain + ' 的发布公钥 …' + key.slice(-8, -1) + '（' + via + '）');
  }
  // 这个圈子的发布公钥：记下的 → 身份文件里电脑端自己记的（加入时从邀请码、或 hello 记的）→ 老电脑连一次控制连接从 hello 取
  // inStart：从 start() 里调的（starting 已经是自己这一次，这时还没有控制连接在跑，可以连）；别处要等没人在启动才连
  async function keysFor(domain, { inStart = false } = {}) {
    let k = keyOf(domain);
    if (k) return [k];
    const st = readState();
    if (st && stateDomain(st) === domain) {
      k = releaseKeyOk(st.releaseKey);
      if (k) { saveKey(domain, k, '身份文件'); return [k]; }
      if (!dev && (inStart || !starting) && !st.revoked) {
        k = await (o.helloKey || helloKey)(st).catch(e => { throw new Error('取不到发布公钥：' + e.message); });
        if (k) { saveKey(domain, k, '中继 hello（老电脑首次）'); return [k]; }
      }
    }
    throw new Error('还没有这个中继的发布公钥：在 clarelay 管理页生成一张新的设备邀请码粘贴进来（同一个圈子不会重新加入、网址不变）');
  }
  const stateDomain = st => st?.domain ? String(st.domain).toLowerCase() : '';

  let loadedDir = '';   // 正在用的电脑端是哪个版本目录（命令行装了新版、点「更新」时按它判断要不要重连）
  async function loadAgent(invite) {
    if (o.load) return o.load();
    let m = await libImport('clarelay');
    if (m?.startDevice) { loadedDir = libDir('clarelay'); return m; }
    const iv = invite ? inviteInfo(invite) : null, st = readState();
    const base = iv ? iv.base : stateBase(st), domain = iv ? iv.domain : stateDomain(st);
    if (!base) throw new Error('还没下载 clarelay 电脑端，也不知道从哪下载：先粘贴设备邀请码');
    log('下载电脑端：' + base);
    try { const r = await libInstall('clarelay', base, { log: o.log, pubkeys: iv?.key ? [iv.key] : await keysFor(domain, { inStart: true }) }); latest = { version: r.info.version, at: Date.now() }; }
    catch (e) { throw new Error('下载 clarelay 电脑端没成：' + e.message); }
    o.onLib?.();
    m = await libImport('clarelay');
    if (!m?.startDevice) throw new Error('clarelay 电脑端下载了但加载不了');
    loadedDir = libDir('clarelay');
    return m;
  }
  function refreshLatest() {
    if (o.load || checking) return;
    const st = readState(), base = stateBase(st);
    if (!base || (latest && Date.now() - latest.at < 6 * 3600e3)) return;
    const k = keyOf(stateDomain(st));   // 查新版只用记下的公钥（不为这个去连控制连接）
    if (!k) return;
    checking = libFetch('clarelay', base, { pubkeys: [k] }).then(m => { latest = { version: m.version, at: Date.now() }; },
      () => { latest = { version: latest?.version || '', at: Date.now() - 5 * 3600e3 }; })   // 查不到：1 小时后再查
      .finally(() => { checking = null; });
  }

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
      // 守护脚本 wscript（命令行里有 clarelay-device.vbs）、它起的 node（命令行里有 device\agent.mjs，clarelay 0.4.0 起是 client\agent.mjs，0.5.2 起是单文件 clarelay.mjs）、占着本机接口端口的进程；不碰自己
      const ps = `$ids = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*clarelay-device.vbs*') -or ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*device\\agent.mjs*' -or $_.CommandLine -like '*device/agent.mjs*' -or $_.CommandLine -like '*client\\agent.mjs*' -or $_.CommandLine -like '*client/agent.mjs*' -or $_.CommandLine -like '*clarelay.mjs*')) } | ForEach-Object { $_.ProcessId })
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
        const { startDevice } = await loadAgent(invite);
        const d = await startDevice({ invite: invite || undefined, state: STATE, name: deviceName(), services: { claclaw: 'http://127.0.0.1:' + o.port }, log, open: o.getOpen?.() || {},
          onStatus: s => { if (s.error) lastErr = s.error; else if (s.online) lastErr = ''; } });   // 每次连不上都带原因；连上（hello）不带 error，清掉
        dev = d; o.onDevice(d); ext.commit(); retryN = 0;
        if (invite) { const iv = inviteInfo(invite); if (iv.key) saveKey(iv.domain, iv.key, '设备邀请码'); }   // 加入成功（同一个圈子不重新加入）：记下邀请码里的发布公钥
        else if (d.releaseKey) { const dm = stateDomain(readState()); if (dm && !keyOf(dm) && releaseKeyOk(d.releaseKey)) saveKey(dm, d.releaseKey, '电脑端 hello'); }
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
    if (st?.id) refreshLatest();
    const lib = o.load ? { installed: true, version: '' } : libInfo('clarelay'), lv = latest?.version || '';
    return {
      joined: !!st?.id, off: !!o.getOff(), running: !!dev, starting: !!starting,
      name: dev?.name || st?.name || '', url, shellUrl: dev?.shellUrl || '',
      online: !!dev?.online, status: dev?.status || st?.status || null, revoked: !!st?.revoked || dev?.status === 'revoked',
      cert: dev ? !!dev.cert?.ok : null, error: lastErr,
      lib: { installed: lib.installed, version: lib.version, latest: lv, update: !!(lib.installed && lv && newerVersion(lv, lib.version)) },
    };
  }

  const api = {
    info,
    device: () => dev,
    // 不过门卫的路径（协同 /claclaw-peer → 本机协同端口）：协同开关、端口变了时调
    setOpen(m) { try { dev?.setOpen?.(m || {}); } catch {} },
    // claclaw 启动、主端口占到之后调：有身份、没撤销、没断开就直接连
    // 没起来（多半是还没下载电脑端、中继一时连不上）：1、2、5、10 分钟后再试，之后每 10 分钟
    autoStart() {
      clearTimeout(retry); retry = null;
      const st = readState();
      if (!st?.id || st.revoked || o.getOff() || dev) return;
      start().catch(e => {
        log('内置电脑端没起来：', e.message);
        const ms = [1, 2, 5, 10][Math.min(retryN++, 3)] * 60e3;
        retry = setTimeout(() => api.autoStart(), ms); retry.unref?.();
      });
    },
    // 下载新版的电脑端；换了就重连（正连着的话）
    async update() {
      const st = readState(), base = stateBase(st);
      if (!base) throw new Error('还没加入 clarelay：不知道从哪下载');
      const r = await libInstall('clarelay', base, { log: o.log, pubkeys: await keysFor(stateDomain(st)) });
      latest = { version: r.info.version, at: Date.now() };
      const moved = r.changed || (loadedDir && loadedDir !== libDir('clarelay'));
      if (moved) {
        o.onLib?.();
        if (dev || starting) { await stop(); await start(); }
      }
      return { ...info(), updated: !!moved };
    },
    async join(invite) {
      // 邀请码：clarelay 复制出来的 JSON（可带换行），或旧的一行 clarelay-device1.…；格式见 clarelay PROTOCOL.md §8.1，由电脑端的 parseDeviceInvite 认
      const v = String(invite || '').trim();
      if (v.startsWith('{')) { try { JSON.parse(v); } catch { throw new Error('邀请码不是完整的 JSON：从 clarelay 复制时要整段复制'); } }
      else if (!/clarelay-device1\./.test(v)) throw new Error('这不是 clarelay 设备邀请码');
      o.setOff(false);
      return start(v);
    },
    async connect() { if (!readState()?.id) throw new Error('还没加入：先粘贴设备邀请码'); o.setOff(false); return start(); },
    async disconnect() { o.setOff(true); clearTimeout(retry); await stop(); return info(); },
    async remove() {
      clearTimeout(retry); await stop();
      const dm = stateDomain(readState()), all = readKeys();   // 退出圈子：记下的发布公钥也删掉，再加入以新邀请码里的为准
      if (dm && all[dm]) { delete all[dm]; try { fs.writeFileSync(KEYS, JSON.stringify(all, null, 2), { mode: 0o600 }); } catch {} }
      try { fs.unlinkSync(STATE); } catch {} o.setOff(false); lastErr = ''; log('已移除本机身份文件'); return info(); },
    stop: async () => { clearTimeout(retry); await stop(); },
  };
  return api;
}
