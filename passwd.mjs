#!/usr/bin/env node
// 改 claclaw 网页登录的「最近一次设置」账号（只保留最后一组；初始账号一直有效）
// 用户名、密码各自可以留空（传 ""），但至少给一个。
//   node passwd.mjs <用户名> <密码>
//   node passwd.mjs "" <密码>        只要密码
//   node passwd.mjs <用户名> ""      只要用户名
//   node passwd.mjs --show           只看现在设置了什么，不显示密码
import { setLastSet, authSummary } from './auth.mjs';

const args = process.argv.slice(2);
if (!args.length || args[0] === '--show') {
  const s = authSummary();
  if (!s) console.log('还没有设置初始账号：打开网页会先让你设置。');
  else {
    console.log('初始账号：' + s.master + '（永远有效）');
    console.log('最近一次设置：' + (s.lastSet || '（无）'));
  }
  if (!args.length) console.log('\n用法：node passwd.mjs <用户名> <密码>（某一项不要就传 ""）');
  process.exit(0);
}
try {
  const r = setLastSet(args[0], args[1]);
  console.log('已改好：' + (r.username ? '用户名「' + r.username + '」' : '用户名留空') + (r.hasPassword ? '，有密码' : '，密码留空') + '。下次登录生效，初始账号仍然可用。');
} catch (e) {
  console.error('修改失败：' + e.message);
  process.exit(1);
}
