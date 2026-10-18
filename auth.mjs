// 登录凭据：
//   初始账号 —— 第一次打开网页时由用户自己设置，之后永远有效（忘了新密码时兜底）；
//   最近一次设置 —— 只保留最后一组，在会话里通过对话修改。
// 两组都是「用户名、密码各自可空，但至少填一个」，登录时两栏都要和设置时一致（空对空）。
// 存在 data/auth.json（密码只存 scrypt 哈希，权限 0600，不进 git）。
// 想重新设置初始账号：删掉 data/auth.json，再打开网页。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA = process.env.CLACLAW_DATA ? path.resolve(process.env.CLACLAW_DATA) : path.join(ROOT, 'data');
const AUTH_FILE = path.join(DATA, 'auth.json');
const TOKENS_FILE = path.join(DATA, 'tokens.json');

export const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}
function check(password, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  const a = Buffer.from(crypto.scryptSync(String(password), rec.salt, 32).toString('hex'));
  const b = Buffer.from(rec.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 每次都从磁盘读：命令行脚本改了密码，服务不用重启就生效
export function loadAuth() {
  const a = readJson(AUTH_FILE, null);
  return a?.master ? a : null;
}

export const isSetUp = () => !!loadAuth();

// 用户名去掉首尾空白；密码原样保存，但不能全是空白。两者至少有一个非空。
function normalize(username, password) {
  username = String(username ?? '').trim();
  password = String(password ?? '');
  if (/\s/.test(username)) throw new Error('用户名不能含空格');
  if (password && !password.trim()) throw new Error('密码不能全是空格');
  if (!username && !password) throw new Error('用户名和密码至少要设置一个');
  return { username, password };
}

function record(username, password) {
  return { username, hasPassword: !!password, ...hash(password), setAt: new Date().toISOString() };
}

// 只能设一次：文件已存在就失败（用 wx 打开，防两个人同时抢着设）
export function setupMaster(username, password) {
  const c = normalize(username, password);
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ master: record(c.username, c.password), lastSet: null }, null, 2), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error('初始账号已经设置过了');
    throw e;
  }
  return { username: c.username };
}

// 返回 'master' | 'lastSet' | null
export function verify(username, password) {
  const a = loadAuth();
  if (!a) return null;
  username = String(username ?? '').trim();
  password = String(password ?? '');
  if (a.lastSet && username === a.lastSet.username && check(password, a.lastSet)) return 'lastSet';
  if (username === a.master.username && check(password, a.master)) return 'master';
  return null;
}

// 只认初始账号（删除会话这类危险操作用）
export function verifyMaster(username, password) {
  const a = loadAuth();
  if (!a) return false;
  return String(username ?? '').trim() === a.master.username && check(String(password ?? ''), a.master);
}

export function setLastSet(username, password) {
  const a = loadAuth();
  if (!a) throw new Error('还没有设置初始账号，请先在网页上完成首次设置');
  const c = normalize(username, password);
  a.lastSet = record(c.username, c.password);
  writeJson(AUTH_FILE, a);
  return { username: c.username, hasPassword: !!c.password, setAt: a.lastSet.setAt };
}

const desc = r => (r.username ? '用户名「' + r.username + '」' : '用户名留空') + (r.hasPassword ? '，有密码' : '，密码留空');

export function authSummary() {
  const a = loadAuth();
  if (!a) return null;
  return { master: desc(a.master), lastSet: a.lastSet ? desc(a.lastSet) + '，设置于 ' + a.lastSet.setAt : null };
}
export { desc as describeCredential };

// ---------- 登录令牌（cookie），只存 sha256 ----------

const sha = t => crypto.createHash('sha256').update(t).digest('hex');

function loadTokens() {
  const now = Date.now();
  const all = readJson(TOKENS_FILE, {});
  for (const [k, v] of Object.entries(all)) if (!v || v.exp < now) delete all[k];
  return all;
}

export function issueToken(via, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  const all = loadTokens();
  all[sha(token)] = { via, ip, created: Date.now(), exp: Date.now() + TOKEN_TTL_MS };
  writeJson(TOKENS_FILE, all);
  return token;
}

export function checkToken(token) {
  if (!token) return false;
  return !!loadTokens()[sha(token)];
}

export function revokeToken(token) {
  if (!token) return;
  const all = loadTokens();
  delete all[sha(token)];
  writeJson(TOKENS_FILE, all);
}
